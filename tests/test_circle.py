"""Circle endpoints, against a fake Circle API (no real key needed)."""

import json

import httpx
import pytest
from eth_account import Account
from fastapi.testclient import TestClient

from dollardrop.circle import ALREADY_INITIALIZED, CircleClient
from dollardrop.relayer.app import create_app
from dollardrop.relayer.core import Relayer

WALLET = "0x1111111111111111111111111111111111111111"


class FakeCircle:
    def __init__(self):
        self.calls = []
        self.initialized = False
        self.lists_usdc = True

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        self.calls.append((request.method, request.url.path, dict(request.headers), body))
        assert request.headers["authorization"] == "Bearer test-key"

        match request.url.path:
            case "/v1/w3s/users/social/token":
                return httpx.Response(200, json={"data": {"deviceToken": "dt", "deviceEncryptionKey": "dek"}})
            case "/v1/w3s/users/email/token":
                return httpx.Response(
                    200, json={"data": {"deviceToken": "dt", "deviceEncryptionKey": "dek", "otpToken": "otp"}}
                )
            case "/v1/w3s/user/initialize":
                if request.headers.get("x-user-token") != "user-token":
                    return httpx.Response(401, json={"code": 155104, "message": "invalid user token"})
                if self.initialized:
                    return httpx.Response(409, json={"code": ALREADY_INITIALIZED, "message": "already initialized"})
                self.initialized = True
                return httpx.Response(201, json={"data": {"challengeId": "challenge-1"}})
            case "/v1/w3s/wallets":
                return httpx.Response(
                    200,
                    json={"data": {"wallets": [
                        {"id": "eth-wallet", "address": "0x2222222222222222222222222222222222222222", "blockchain": "ETH"},
                        {"id": "arc-wallet", "address": WALLET, "blockchain": "ARC"},
                    ]}},
                )
            case "/v1/w3s/wallets/arc-wallet/balances":
                tokens = [{"token": {"id": "usdc-token", "symbol": "USDC", "blockchain": "ARC"}, "amount": "12.5"}]
                return httpx.Response(200, json={"data": {"tokenBalances": tokens if self.lists_usdc else []}})
            case "/v1/w3s/user/transactions/transfer":
                return httpx.Response(201, json={"data": {"challengeId": "transfer-challenge"}})
        return httpx.Response(404, json={"message": "not found"})


@pytest.fixture
def fake():
    return FakeCircle()


@pytest.fixture
def relayer(w3, dd):
    return Relayer(w3, dd, Account.create())


@pytest.fixture
def client(relayer, fake):
    circle = CircleClient("test-key", "ARC", transport=httpx.MockTransport(fake))
    return TestClient(create_app(relayer, circle=circle))


def test_circle_routes_absent_without_key(w3, dd):
    client = TestClient(create_app(Relayer(w3, dd, Account.create())))
    assert client.post("/circle/social-token", json={"deviceId": "d"}).status_code == 404
    assert client.get("/health").json()["circle"] is False


def test_social_token(client, fake):
    resp = client.post("/circle/social-token", json={"deviceId": "device-1"})
    assert resp.json() == {"deviceToken": "dt", "deviceEncryptionKey": "dek"}
    assert fake.calls[0][3]["deviceId"] == "device-1"


def test_email_token(client, fake):
    resp = client.post("/circle/email-token", json={"deviceId": "device-1", "email": "a@example.com"})
    assert resp.json()["otpToken"] == "otp"
    assert fake.calls[0][3]["email"] == "a@example.com"


def test_email_must_look_like_email(client):
    assert client.post("/circle/email-token", json={"deviceId": "d", "email": "nope"}).status_code == 422


def test_wallet_first_returns_challenge_then_address(client, fake):
    first = client.post("/circle/wallet", json={"userToken": "user-token"}).json()
    assert first == {"challengeId": "challenge-1", "address": None}
    init = next(c for c in fake.calls if c[1] == "/v1/w3s/user/initialize")
    assert init[3]["blockchains"] == ["ARC"]
    assert init[3]["accountType"] == "EOA"

    second = client.post("/circle/wallet", json={"userToken": "user-token"}).json()
    assert second == {"challengeId": None, "address": WALLET}  # only the Arc wallet


def test_bad_user_token_is_400(client):
    resp = client.post("/circle/wallet", json={"userToken": "wrong"})
    assert resp.status_code == 400
    assert "invalid user token" in resp.json()["detail"]


# ------------------------------------------------------------------ transfers out of a Circle wallet

DEST = "0x3333333333333333333333333333333333333333"


def _transfer_body(fake):
    return next(c for c in fake.calls if c[1] == "/v1/w3s/user/transactions/transfer")[3]


def test_transfer_uses_users_arc_wallet_and_usdc_token(client, fake):
    resp = client.post("/circle/transfer", json={"userToken": "user-token", "destinationAddress": DEST, "amount": "2.50"})

    assert resp.json() == {"challengeId": "transfer-challenge"}
    body = _transfer_body(fake)
    assert body["walletId"] == "arc-wallet"
    assert body["tokenId"] == "usdc-token"
    assert body["destinationAddress"] == DEST
    assert body["amounts"] == ["2.50"]


def test_transfer_falls_back_to_usdc_address_when_circle_lists_no_token(client, fake):
    fake.lists_usdc = False
    client.post("/circle/transfer", json={"userToken": "user-token", "destinationAddress": DEST, "amount": "1"})

    body = _transfer_body(fake)
    assert "tokenId" not in body
    assert body["tokenAddress"] == "0x3600000000000000000000000000000000000000"
    assert body["blockchain"] == "ARC"


@pytest.mark.parametrize("amount", ["0", "0.000000", "-1", "1.1234567", "abc", "", "01"])
def test_transfer_rejects_bad_amounts(client, fake, amount):
    resp = client.post("/circle/transfer", json={"userToken": "user-token", "destinationAddress": DEST, "amount": amount})
    assert resp.status_code in (400, 422)
    assert not any(c[1] == "/v1/w3s/user/transactions/transfer" for c in fake.calls)


@pytest.mark.parametrize(
    "destination",
    [
        "0x0000000000000000000000000000000000000000",
        "0x3600000000000000000000000000000000000000",  # the USDC contract itself
        "contract",  # our DollarDrop money box
    ],
)
def test_transfer_refuses_addresses_where_money_is_lost(client, fake, relayer, destination):
    if destination == "contract":
        destination = relayer.contract.address
    resp = client.post("/circle/transfer", json={"userToken": "user-token", "destinationAddress": destination, "amount": "1"})
    assert resp.status_code == 400
    assert not any(c[1] == "/v1/w3s/user/transactions/transfer" for c in fake.calls)
