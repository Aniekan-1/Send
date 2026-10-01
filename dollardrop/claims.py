"""Claim keys and EIP-712 claim signatures.

Every drop is locked to a one-time claim key. The private key travels only inside the link
(after the `#`, so browsers never send it to a server). To claim, the key signs
Claim(recipient, relayer, fee); the contract checks the signer is the drop's claim key.

This module must stay byte-for-byte compatible with DollarDrop.CLAIM_TYPEHASH and the
EIP712("DollarDrop", "1") domain in contracts/DollarDrop.sol.
"""

from dataclasses import dataclass

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import to_checksum_address

DOMAIN_NAME = "DollarDrop"
DOMAIN_VERSION = "1"

CLAIM_TYPES = {
    "Claim": [
        {"name": "recipient", "type": "address"},
        {"name": "relayer", "type": "address"},
        {"name": "fee", "type": "uint256"},
    ]
}

ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"


@dataclass(frozen=True)
class ClaimKey:
    private_key: str  # 0x-prefixed hex; this is the secret that goes in the link
    address: str  # what the contract stores


def new_claim_key() -> ClaimKey:
    acct = Account.create()
    return ClaimKey(private_key="0x" + bytes(acct.key).hex(), address=acct.address)


def claim_key_from_secret(private_key: str) -> ClaimKey:
    acct = Account.from_key(private_key)
    return ClaimKey(private_key=private_key, address=acct.address)


def _domain(chain_id: int, contract: str) -> dict:
    return {
        "name": DOMAIN_NAME,
        "version": DOMAIN_VERSION,
        "chainId": chain_id,
        "verifyingContract": to_checksum_address(contract),
    }


def _message(recipient: str, relayer: str, fee: int) -> dict:
    return {
        "recipient": to_checksum_address(recipient),
        "relayer": to_checksum_address(relayer),
        "fee": fee,
    }


def sign_claim(private_key: str, *, chain_id: int, contract: str,
               recipient: str, relayer: str, fee: int) -> bytes:
    """Sign a claim with the drop's claim key. Returns the 65-byte signature."""
    signable = encode_typed_data(_domain(chain_id, contract), CLAIM_TYPES, _message(recipient, relayer, fee))
    return bytes(Account.sign_message(signable, private_key).signature)


def recover_claim_signer(signature: bytes, *, chain_id: int, contract: str,
                         recipient: str, relayer: str, fee: int) -> str:
    """Address that signed this claim. The relayer uses it to reject bad claims before paying gas."""
    signable = encode_typed_data(_domain(chain_id, contract), CLAIM_TYPES, _message(recipient, relayer, fee))
    return Account.recover_message(signable, signature=signature)
