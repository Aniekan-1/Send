"""Server side of Circle user-controlled wallets (Google / email sign-in on the claim page).

The Circle API key must never reach the browser, so the claim page calls these endpoints and
we forward to Circle. We only ever learn the user's wallet *address*: the wallet's keys stay with
the user (Circle's user-controlled model), and the claim itself is signed by the link's claim key.

Docs: https://developers.circle.com/wallets/user-controlled/create-user-wallets-with-social-login
"""

import uuid

import httpx

from dollardrop.arc import ARC_USDC

CIRCLE_API = "https://api.circle.com"
ALREADY_INITIALIZED = 155106

# Circle's blockchain identifiers for Arc.
BLOCKCHAINS = {5042: "ARC", 5042002: "ARC-TESTNET"}


class CircleError(Exception):
    def __init__(self, status: int, code: int | None, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class CircleClient:
    def __init__(self, api_key: str, blockchain: str, *, base_url: str = CIRCLE_API, transport=None):
        self.blockchain = blockchain
        self._http = httpx.Client(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            timeout=15,
            transport=transport,
        )

    def _request(self, method: str, path: str, *, user_token: str | None = None, json: dict | None = None) -> dict:
        headers = {"X-User-Token": user_token} if user_token else None
        resp = self._http.request(method, path, json=json, headers=headers)
        body = resp.json() if resp.content else {}
        if resp.is_error:
            raise CircleError(resp.status_code, body.get("code"), body.get("message", "Circle request failed"))
        return body.get("data", {})

    def social_device_token(self, device_id: str) -> dict:
        """-> {deviceToken, deviceEncryptionKey}"""
        return self._request(
            "POST", "/v1/w3s/users/social/token", json={"idempotencyKey": str(uuid.uuid4()), "deviceId": device_id}
        )

    def email_device_token(self, device_id: str, email: str) -> dict:
        """-> {deviceToken, deviceEncryptionKey, otpToken}; Circle emails the code."""
        return self._request(
            "POST",
            "/v1/w3s/users/email/token",
            json={"idempotencyKey": str(uuid.uuid4()), "deviceId": device_id, "email": email},
        )

    def initialize_user(self, user_token: str) -> str | None:
        """Create the user's Arc wallet. Returns a challengeId for the SDK to execute, or None if it exists."""
        try:
            data = self._request(
                "POST",
                "/v1/w3s/user/initialize",
                user_token=user_token,
                # EOA: the wallet pays its own gas in USDC, which on Arc is the money it holds anyway.
                json={"idempotencyKey": str(uuid.uuid4()), "accountType": "EOA", "blockchains": [self.blockchain]},
            )
        except CircleError as e:
            if e.code == ALREADY_INITIALIZED:
                return None
            raise
        return data.get("challengeId")

    def wallets(self, user_token: str) -> list[dict]:
        """The user's wallets on our Arc network: [{"id", "address", "blockchain", ...}]."""
        data = self._request("GET", f"/v1/w3s/wallets?blockchain={self.blockchain}", user_token=user_token)
        return [w for w in data.get("wallets", []) if w.get("blockchain") == self.blockchain]

    def wallet_addresses(self, user_token: str) -> list[str]:
        return [w["address"] for w in self.wallets(user_token)]

    def _usdc_token_id(self, user_token: str, wallet_id: str) -> str | None:
        """Circle's id for USDC in this wallet, if Circle lists it among the wallet's balances."""
        data = self._request("GET", f"/v1/w3s/wallets/{wallet_id}/balances", user_token=user_token)
        for balance in data.get("tokenBalances", []):
            token = balance.get("token", {})
            if token.get("symbol") == "USDC" and token.get("blockchain") == self.blockchain:
                return token.get("id")
        return None

    def create_transfer(self, user_token: str, destination: str, amount: str) -> str:
        """Start a USDC transfer from the user's wallet. Returns a challengeId the user approves in the SDK."""
        wallets = self.wallets(user_token)
        if not wallets:
            raise CircleError(404, None, "no Arc wallet for this user")
        wallet_id = wallets[0]["id"]

        token_id = self._usdc_token_id(user_token, wallet_id)
        token = {"tokenId": token_id} if token_id else {"tokenAddress": ARC_USDC, "blockchain": self.blockchain}
        data = self._request(
            "POST",
            "/v1/w3s/user/transactions/transfer",
            user_token=user_token,
            json={
                "idempotencyKey": str(uuid.uuid4()),
                "walletId": wallet_id,
                **token,
                "destinationAddress": destination,
                "amounts": [amount],
                "feeLevel": "MEDIUM",
            },
        )
        return data["challengeId"]
