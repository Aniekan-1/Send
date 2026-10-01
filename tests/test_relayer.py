import pytest
from eth_account import Account
from fastapi.testclient import TestClient

from dollardrop.arc import usdc
from dollardrop.relayer.app import create_app
from dollardrop.relayer.core import CLAIM_GAS, Relayer
from dollardrop.relayer.ratelimit import RateLimiter


@pytest.fixture
def relayer(w3, dd, accounts):
    acct = Account.create()
    w3.eth.send_transaction({"from": accounts["organizer"], "to": acct.address, "value": 10**21})
    return Relayer(w3, dd, acct)


@pytest.fixture
def client(relayer):
    return TestClient(create_app(relayer))


@pytest.fixture
def signed_claim(relayer, sign):
    """Body for POST /claims, signed the way the claim page will sign it."""

    def _body(key, recipient, fee=None):
        if fee is None:
            fee = relayer.quote_fee(usdc("0.05"))
        sig = sign(key, recipient, relayer.address, fee)
        return {"claimKey": key.address, "recipient": recipient, "fee": fee, "signature": "0x" + sig.hex()}

    return _body


def nonce(w3, relayer):
    return w3.eth.get_transaction_count(relayer.address)


# ------------------------------------------------------------------ reads


def test_health(client, relayer):
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["relayer"] == relayer.address


def test_get_drop_returns_amount_and_fee_quote(client, relayer, create_campaign):
    _, keys = create_campaign(amount=usdc(10), fee_cap=usdc("0.05"))

    body = client.get(f"/drops/{keys[0].address}").json()

    assert body["status"] == "active"
    assert body["amount"] == usdc(10)
    assert 0 < body["fee"] <= usdc("0.05")
    assert body["receive"] == usdc(10) - body["fee"]
    assert body["relayer"] == relayer.address


def test_get_unknown_drop_is_404(client):
    assert client.get(f"/drops/{Account.create().address}").status_code == 404


def test_get_drop_rejects_garbage_key(client):
    assert client.get("/drops/not-an-address").status_code == 400


def test_quote_never_exceeds_cap(relayer):
    assert relayer.quote_fee(1) == 1


# ------------------------------------------------------------------ claims


def test_claim_pays_recipient_and_relayer(client, w3, token, relayer, accounts, create_campaign, signed_claim):
    _, keys = create_campaign(amount=usdc(10))
    alice = accounts["alice"]
    body = signed_claim(keys[0], alice)

    resp = client.post("/claims", json=body)

    assert resp.status_code == 200, resp.text
    assert resp.json()["amount"] == usdc(10) - body["fee"]
    assert token.functions.balanceOf(alice).call() == usdc(10) - body["fee"]
    assert token.functions.balanceOf(relayer.address).call() == body["fee"]
    assert client.get(f"/drops/{keys[0].address}").json()["status"] == "claimed"


def test_claim_gas_stays_under_budget(w3, relayer, accounts, create_campaign, signed_claim, client):
    """The relayer sends claims with a fixed gas limit; real usage must fit with room to spare."""
    _, keys = create_campaign()
    tx = client.post("/claims", json=signed_claim(keys[0], accounts["alice"])).json()["txHash"]
    used = w3.eth.get_transaction_receipt(tx).gasUsed
    assert used < CLAIM_GAS * 0.9, f"claim used {used} gas; raise CLAIM_GAS"


def test_wrong_recipient_rejected_before_sending(client, w3, relayer, accounts, create_campaign, signed_claim):
    _, keys = create_campaign()
    body = signed_claim(keys[0], accounts["alice"])
    body["recipient"] = accounts["mallory"]
    before = nonce(w3, relayer)

    resp = client.post("/claims", json=body)

    assert resp.status_code == 400
    assert "signature" in resp.json()["detail"]
    assert nonce(w3, relayer) == before, "relayer must not spend gas on a bad claim"


def test_signature_for_other_relayer_rejected(client, w3, relayer, accounts, create_campaign, sign):
    _, keys = create_campaign()
    alice = accounts["alice"]
    fee = relayer.quote_fee(usdc("0.05"))
    sig = sign(keys[0], alice, accounts["mallory"], fee)  # signed for someone else's relayer

    resp = client.post(
        "/claims", json={"claimKey": keys[0].address, "recipient": alice, "fee": fee, "signature": "0x" + sig.hex()}
    )
    assert resp.status_code == 400


def test_fee_too_low_rejected(client, accounts, create_campaign, signed_claim):
    _, keys = create_campaign()
    resp = client.post("/claims", json=signed_claim(keys[0], accounts["alice"], fee=0))
    assert resp.status_code == 400
    assert "fee too low" in resp.json()["detail"]


def test_fee_above_cap_rejected(client, accounts, create_campaign, signed_claim):
    _, keys = create_campaign(fee_cap=usdc("0.05"))
    resp = client.post("/claims", json=signed_claim(keys[0], accounts["alice"], fee=usdc("0.06")))
    assert resp.status_code == 400


def test_already_claimed_is_409(client, accounts, create_campaign, signed_claim):
    _, keys = create_campaign()
    assert client.post("/claims", json=signed_claim(keys[0], accounts["alice"])).status_code == 200

    resp = client.post("/claims", json=signed_claim(keys[0], accounts["bob"]))
    assert resp.status_code == 409


def test_second_drop_same_wallet_is_409_without_sending(client, w3, relayer, accounts, create_campaign, signed_claim):
    """Caught by the free simulation, so no gas is wasted."""
    _, keys = create_campaign(n=2)
    alice = accounts["alice"]
    assert client.post("/claims", json=signed_claim(keys[0], alice)).status_code == 200
    before = nonce(w3, relayer)

    resp = client.post("/claims", json=signed_claim(keys[1], alice))

    assert resp.status_code == 409
    assert resp.json()["detail"] == "AlreadyClaimed"
    assert nonce(w3, relayer) == before


def test_paused_campaign_is_409(client, dd, accounts, create_campaign, signed_claim):
    campaign_id, keys = create_campaign()
    dd.functions.setPaused(campaign_id, True).transact({"from": accounts["organizer"]})

    resp = client.post("/claims", json=signed_claim(keys[0], accounts["alice"]))
    assert resp.status_code == 409
    assert resp.json()["detail"] == "CampaignPaused"


def test_malformed_body_is_422(client):
    resp = client.post("/claims", json={"claimKey": "0x123", "recipient": "nope", "fee": -1, "signature": "0x00"})
    assert resp.status_code == 422


def test_malformed_signature_rejected(client, accounts, create_campaign, relayer):
    _, keys = create_campaign()
    body = {
        "claimKey": keys[0].address,
        "recipient": accounts["alice"],
        "fee": relayer.quote_fee(usdc("0.05")),
        "signature": "0x" + "00" * 65,
    }
    assert client.post("/claims", json=body).status_code == 400


def test_low_relayer_balance_is_503(w3, dd, accounts, create_campaign, sign):
    broke = Relayer(w3, dd, Account.create(), min_balance=1)
    client = TestClient(create_app(broke))
    _, keys = create_campaign()
    fee = broke.quote_fee(usdc("0.05"))
    sig = sign(keys[0], accounts["alice"], broke.address, fee)

    resp = client.post(
        "/claims",
        json={"claimKey": keys[0].address, "recipient": accounts["alice"], "fee": fee, "signature": "0x" + sig.hex()},
    )
    assert resp.status_code == 503
    assert client.get("/health").json()["ok"] is False


# ------------------------------------------------------------------ rate limiting


def test_claims_are_rate_limited(relayer, accounts):
    client = TestClient(create_app(relayer, claims_per_minute=2))
    junk = {"claimKey": Account.create().address, "recipient": accounts["alice"], "fee": 1, "signature": "0x" + "11" * 65}

    codes = [client.post("/claims", json=junk).status_code for _ in range(3)]
    assert codes[-1] == 429
    assert 429 not in codes[:2]


def test_rate_limiter_window_slides():
    t = [0.0]
    limiter = RateLimiter(2, 60, clock=lambda: t[0])
    assert limiter.allow("ip") and limiter.allow("ip")
    assert not limiter.allow("ip")
    assert limiter.allow("other-ip")
    t[0] = 61
    assert limiter.allow("ip")
