from contextlib import contextmanager

import pytest
from web3 import Web3
from web3.providers.eth_tester import EthereumTesterProvider

from dollardrop import claims
from dollardrop.arc import usdc
from dollardrop.compile import compile_all
from dollardrop.reverts import error_name

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


@pytest.fixture
def reverts():
    """with reverts(contract, "ErrorName"): ... asserts the call reverts with that custom error."""

    @contextmanager
    def _reverts(contract, name):
        with pytest.raises(Exception) as exc:
            yield
        got = error_name(contract.abi, exc.value)
        assert got == name, f"expected revert {name}, got {got or repr(exc.value)}"

    return _reverts
