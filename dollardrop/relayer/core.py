"""Everything the relayer does on-chain, independent of HTTP.

The relayer never sees a claim key's secret. The claim page signs Claim(recipient, relayer, fee)
in the browser and sends only the signature. Before spending any gas the relayer:

1. checks the signature really comes from the drop's claim key,
2. checks the fee covers its cost and is within the campaign's cap,
3. simulates the claim (free eth_call), so anything the contract would reject is rejected here.
"""

import logging
import threading
from dataclasses import asdict, dataclass
from enum import IntEnum

from eth_account.signers.local import LocalAccount
from web3 import Web3
from web3.contract import Contract

from dollardrop import claims
from dollardrop.arc import MIN_MAX_FEE_PER_GAS, native_to_usdc_units
from dollardrop.reverts import error_name

log = logging.getLogger(__name__)

# Gas budget used to price the fee quote. A claim measures ~141k when both the recipient and
# relayer hold no USDC yet (worst case); tests assert real usage stays well below this.
CLAIM_GAS = 180_000
# Headroom on top of eth_estimateGas for the gas limit of the real transaction.
GAS_LIMIT_HEADROOM = 1.2


class Status(IntEnum):
    NONE = 0
    ACTIVE = 1
    CLAIMED = 2
    REFUNDED = 3


@dataclass(frozen=True)
class Drop:
    claim_key: str
    campaign_id: int
    status: Status
    amount: int  # USDC, 6 decimals
    expires_at: int
    fee_cap: int
    paused: bool

    def to_json(self) -> dict:
        d = asdict(self)
        d["status"] = self.status.name.lower()
        return d


class ClaimRejected(Exception):
    """A claim we refuse to submit. `kind` maps to an HTTP status in the API."""

    def __init__(self, kind: str, reason: str):
        super().__init__(reason)
        self.kind = kind  # "invalid" | "conflict" | "unavailable"
        self.reason = reason


# Contract errors that mean "this drop can't be claimed (any more)" rather than "your request is malformed".
CONFLICT_ERRORS = {"DropNotActive", "CampaignPaused", "CampaignExpired", "AlreadyClaimed"}


@dataclass(frozen=True)
class ClaimResult:
    tx_hash: str
    claim_key: str
    recipient: str
    amount: int  # what the recipient received
    fee: int
    gas_used: int


class Relayer:
    def __init__(
        self,
        w3: Web3,
        contract: Contract,
        account: LocalAccount,
        *,
        fee_margin: float = 0.5,
        min_balance: int = 0,
        receipt_timeout: float = 30,
    ):
        self.w3 = w3
        self.contract = contract
        self.account = account
        self.fee_margin = fee_margin  # quote = cost * (1 + margin), to absorb gas price moves
        self.min_balance = min_balance  # native (18-dec) balance below which we stop relaying
        self.receipt_timeout = receipt_timeout
        self.chain_id = w3.eth.chain_id
        self._send_lock = threading.Lock()  # one transaction at a time keeps nonces simple

    @property
    def address(self) -> str:
        return self.account.address

    # ------------------------------------------------------------ reads

    def balance(self) -> int:
        return self.w3.eth.get_balance(self.address)

    def drop(self, claim_key: str) -> Drop:
        key = Web3.to_checksum_address(claim_key)
        campaign_id, status, amount, expires_at, fee_cap, paused = self.contract.functions.getDrop(key).call()
        return Drop(key, campaign_id, Status(status), amount, expires_at, fee_cap, paused)

    def _max_fee_per_gas(self) -> int:
        return max(2 * self.w3.eth.gas_price, MIN_MAX_FEE_PER_GAS)

    def claim_cost(self) -> int:
        """Worst-case cost of one claim in USDC (6 decimals). On Arc gas is USDC, so no price feed is needed."""
        return native_to_usdc_units(CLAIM_GAS * self._max_fee_per_gas())

    def quote_fee(self, fee_cap: int) -> int:
        """Fee the claim page should sign: our cost plus a margin, never above the campaign's cap."""
        return min(int(self.claim_cost() * (1 + self.fee_margin)), fee_cap)

    # ------------------------------------------------------------ claim

    def submit(self, claim_key: str, recipient: str, fee: int, signature: bytes) -> ClaimResult:
        try:
            claim_key = Web3.to_checksum_address(claim_key)
            recipient = Web3.to_checksum_address(recipient)
        except ValueError as e:
            raise ClaimRejected("invalid", f"bad address: {e}") from None

        if self.balance() < self.min_balance:
            log.error("relayer balance below minimum; refusing claims")
            raise ClaimRejected("unavailable", "relayer is out of funds, try again later")

        drop = self.drop(claim_key)
        if drop.status != Status.ACTIVE:
            raise ClaimRejected("conflict", f"drop is {drop.status.name.lower()}")
        if fee > drop.fee_cap:
            raise ClaimRejected("invalid", "fee above the campaign's cap")
        if fee < min(self.claim_cost(), drop.fee_cap):
            raise ClaimRejected("invalid", "fee too low; fetch a fresh quote")

        try:
            signer = claims.recover_claim_signer(
                signature,
                chain_id=self.chain_id,
                contract=self.contract.address,
                recipient=recipient,
                relayer=self.address,
                fee=fee,
            )
        except Exception:
            raise ClaimRejected("invalid", "malformed signature") from None
        if signer != claim_key:
            raise ClaimRejected("invalid", "signature does not match this drop")

        call = self.contract.functions.claim(claim_key, recipient, self.address, fee, signature)
        gas = self._simulate(call)
        return self._send(call, gas, claim_key, recipient, fee, drop.amount)

    def _simulate(self, call) -> int:
        """Dry-run the claim (free). Returns its gas estimate, or raises ClaimRejected with the contract's error."""
        try:
            return call.estimate_gas({"from": self.address})
        except Exception as e:
            name = error_name(self.contract.abi, e)
            if name is None:
                log.warning("claim simulation failed: %r", e)
                raise ClaimRejected("invalid", "claim would fail on-chain") from None
            kind = "conflict" if name in CONFLICT_ERRORS else "invalid"
            raise ClaimRejected(kind, name) from None

    def _send(self, call, gas: int, claim_key: str, recipient: str, fee: int, drop_amount: int) -> ClaimResult:
        with self._send_lock:
            tx = call.build_transaction(
                {
                    "from": self.address,
                    "nonce": self.w3.eth.get_transaction_count(self.address, "pending"),
                    "gas": int(gas * GAS_LIMIT_HEADROOM),
                    "maxFeePerGas": self._max_fee_per_gas(),
                    "maxPriorityFeePerGas": 0,
                    "chainId": self.chain_id,
                }
            )
            tx_hash = self.w3.eth.send_raw_transaction(self.account.sign_transaction(tx).raw_transaction)
            receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=self.receipt_timeout)

        tx_hex = "0x" + bytes(tx_hash).hex()
        if receipt.status != 1:
            log.error("claim tx reverted: %s", tx_hex)
            raise ClaimRejected("conflict", f"claim transaction failed: {tx_hex}")

        amount = drop_amount - fee
        log.info("claimed %s -> %s amount=%d fee=%d tx=%s", claim_key, recipient, amount, fee, tx_hex)
        return ClaimResult(tx_hex, claim_key, recipient, amount, fee, receipt.gasUsed)
