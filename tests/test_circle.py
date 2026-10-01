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
                        {"address": "0x2222222222222222222222222222222222222222", "blockchain": "ETH"},
                        {"address": WALLET, "blockchain": "ARC"},
                    ]}},
                )
        return httpx.Response(404, json={"message": "not found"})


@pytest.fixture
def fake():
    return FakeCircle()


@pytest.fixture
def client(w3, dd, fake):
    circle = CircleClient("test-key", "ARC", transport=httpx.MockTransport(fake))
    return TestClient(create_app(Relayer(w3, dd, Account.create()), circle=circle))


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
