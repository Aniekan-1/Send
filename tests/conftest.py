from contextlib import contextmanager

import pytest
from eth_utils import keccak
from web3 import Web3
from web3.exceptions import ContractCustomError
from web3.providers.eth_tester import EthereumTesterProvider

from dollardrop import claims
from dollardrop.arc import usdc
from dollardrop.compile import compile_all

DAY = 24 * 60 * 60


@pytest.fixture(scope="session")
def artifacts():
    return compile_all()


@pytest.fixture
def w3():
    return Web3(EthereumTesterProvider())


@pytest.fixture
def accounts(w3):
    organizer, relayer, alice, bob, mallory, *_ = w3.eth.accounts
    return {"organizer": organizer, "relayer": relayer, "alice": alice, "bob": bob, "mallory": mallory}


def _deploy(w3, artifact, *args, sender):
    factory = w3.eth.contract(abi=artifact["abi"], bytecode=artifact["bytecode"])
    receipt = w3.eth.wait_for_transaction_receipt(factory.constructor(*args).transact({"from": sender}))
    return w3.eth.contract(address=receipt.contractAddress, abi=artifact["abi"])


@pytest.fixture
def token(w3, artifacts, accounts):
    t = _deploy(w3, artifacts["MockUSDC"], sender=accounts["organizer"])
    t.functions.mint(accounts["organizer"], usdc(10_000)).transact({"from": accounts["organizer"]})
    return t


@pytest.fixture
def dd(w3, artifacts, accounts, token):
    return _deploy(w3, artifacts["DollarDrop"], token.address, sender=accounts["organizer"])


@pytest.fixture
def now(w3):
    return lambda: w3.eth.get_block("latest")["timestamp"]


@pytest.fixture
def time_travel(w3):
    def _travel(seconds):
        tester = w3.provider.ethereum_tester
        tester.time_travel(w3.eth.get_block("latest")["timestamp"] + seconds)
        tester.mine_blocks()

    return _travel


@pytest.fixture
def create_campaign(dd, token, accounts, now):
    """Fund a campaign; returns (campaign_id, [ClaimKey, ...])."""

    def _create(n=3, amount=usdc(10), fee_cap=usdc("0.05"), expires_in=DAY, owner=None):
        owner = owner or accounts["organizer"]
        keys = [claims.new_claim_key() for _ in range(n)]
        token.functions.approve(dd.address, amount * n).transact({"from": owner})
        dd.functions.createCampaign(amount, now() + expires_in, fee_cap, [k.address for k in keys]).transact(
            {"from": owner}
        )
        return dd.functions.campaignCount().call(), keys

    return _create


@pytest.fixture
def sign(w3, dd):
    """sign(key, recipient, relayer, fee, **overrides) -> signature bytes"""

    def _sign(key, recipient, relayer, fee, chain_id=None, contract=None):
        return claims.sign_claim(
            key.private_key,
            chain_id=chain_id or w3.eth.chain_id,
            contract=contract or dd.address,
            recipient=recipient,
            relayer=relayer,
            fee=fee,
        )

    return _sign


def _error_selector(abi, name):
    for item in abi:
        if item["type"] == "error" and item["name"] == name:
            sig = f"{name}({','.join(i['type'] for i in item['inputs'])})"
            return "0x" + keccak(text=sig)[:4].hex()
    raise KeyError(f"no custom error {name!r} in ABI")


def _revert_data(exc: BaseException) -> str | None:
    """Raw revert bytes as 0x-hex, from web3's ContractCustomError or eth-tester's wrapped py-evm Revert."""
    while exc is not None:
        if isinstance(exc, ContractCustomError):
            return exc.data if isinstance(exc.data, str) else "0x" + exc.data.hex()
        if type(exc).__name__ == "Revert" and exc.args and isinstance(exc.args[0], bytes):
            return "0x" + exc.args[0].hex()
        exc = exc.__cause__ or exc.__context__
    return None


@pytest.fixture
def reverts():
    """with reverts(contract, "ErrorName"): ... asserts the call reverts with that custom error."""

    @contextmanager
    def _reverts(contract, name):
        selector = _error_selector(contract.abi, name)
        with pytest.raises(Exception) as exc:
            yield
        data = _revert_data(exc.value)
        assert data is not None, f"expected revert {name}, got {exc.value!r}"
        assert data.startswith(selector), f"expected {name} ({selector}), got {data[:10]}"

    return _reverts
