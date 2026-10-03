"""HTTP API for the claim page.

    GET  /health               relayer status and balance
    GET  /drops/{claim_key}    what a drop is worth and the fee to sign
    POST /claims               submit a signed claim

    Only when a Circle API key is configured (Google / email sign-in for recipients):
    POST /circle/social-token  device token for Google sign-in
    POST /circle/email-token   device token + emailed one-time code
    POST /circle/wallet        create (if needed) and return the user's Arc wallet
    POST /circle/transfer      start a USDC transfer out of the user's wallet (user approves in the SDK)

    Dashboards (when an event index is attached):
    GET  /stats/public                      aggregate totals for the landing page
    GET  /organizers/{address}/campaigns    an organizer's campaigns with progress
    GET  /campaigns/{id}                    one campaign with every drop
    GET  /admin/overview                    operator view; needs "Authorization: Bearer <ADMIN_TOKEN>"

Run:  uv run python -m dollardrop.relayer
"""

import hmac
import logging
from decimal import Decimal

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from web3 import Web3

from dollardrop.arc import ARC_USDC, NATIVE_DECIMALS
from dollardrop import stats
from dollardrop.circle import CircleClient, CircleError
from dollardrop.indexer import Index, Indexer
from dollardrop.relayer.core import ClaimRejected, Relayer, Status
from dollardrop.relayer.ratelimit import RateLimiter

log = logging.getLogger(__name__)

HTTP_STATUS = {"invalid": 400, "conflict": 409, "unavailable": 503}

ADDRESS = r"^0x[0-9a-fA-F]{40}$"
SIGNATURE = r"^0x[0-9a-fA-F]{130}$"


class ClaimRequest(BaseModel):
    claimKey: str = Field(pattern=ADDRESS)
    recipient: str = Field(pattern=ADDRESS)
    fee: int = Field(ge=0)
    signature: str = Field(pattern=SIGNATURE)


class DeviceRequest(BaseModel):
    deviceId: str = Field(min_length=1, max_length=200)


class EmailRequest(DeviceRequest):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=254)


class UserRequest(BaseModel):
    userToken: str = Field(min_length=1, max_length=4096)


class TransferRequest(UserRequest):
    destinationAddress: str = Field(pattern=ADDRESS)
    amount: str = Field(pattern=r"^(0|[1-9]\d{0,8})(\.\d{1,6})?$")  # dollars, up to 6 decimals


def create_app(
    relayer: Relayer,
    *,
    cors_origins: list[str] | None = None,
    claims_per_minute: int = 5,
    reads_per_minute: int = 60,
    circle: CircleClient | None = None,
    indexer: Indexer | None = None,
    admin_token: str | None = None,
) -> FastAPI:
    # No /docs, /redoc or /openapi.json in production: the routes are listed in this module's docstring.
    app = FastAPI(title="Dollar Drop relayer", docs_url=None, redoc_url=None, openapi_url=None)
    if cors_origins:
        app.add_middleware(
            CORSMiddleware, allow_origins=cors_origins, allow_methods=["GET", "POST"], allow_headers=["*"]
        )

    claim_limit = RateLimiter(claims_per_minute, 60)
    read_limit = RateLimiter(reads_per_minute, 60)

    def client_ip(request: Request) -> str:
        # Behind a proxy, configure it to set the client address (e.g. uvicorn --proxy-headers).
        return request.client.host if request.client else "unknown"

    @app.get("/health")
    def health():
        balance = relayer.balance()
        return {
            "ok": balance >= relayer.min_balance,
            "relayer": relayer.address,
            "balanceUsdc": balance / 10**NATIVE_DECIMALS,
            "chainId": relayer.chain_id,
            "contract": relayer.contract.address,
            "circle": circle is not None,
        }

    @app.get("/drops/{claim_key}")
    def get_drop(claim_key: str, request: Request):
        if not read_limit.allow(client_ip(request)):
            raise HTTPException(429, "too many requests")
        if not Web3.is_address(claim_key):
            raise HTTPException(400, "bad claim key")

        drop = relayer.drop(claim_key)
        if drop.status == Status.NONE:
            raise HTTPException(404, "no such drop")

        fee = relayer.quote_fee(drop.fee_cap)
        return {
            **drop.to_json(),
            # What the claim page signs: Claim(recipient, relayer, fee) in this EIP-712 domain.
            "fee": fee,
            "receive": drop.amount - fee,
            "relayer": relayer.address,
            "chainId": relayer.chain_id,
            "contract": relayer.contract.address,
        }

    @app.post("/claims")
    def post_claim(body: ClaimRequest, request: Request):
        ip = client_ip(request)
        if not claim_limit.allow(ip):
            raise HTTPException(429, "too many claims, wait a minute")

        try:
            result = relayer.submit(body.claimKey, body.recipient, body.fee, bytes.fromhex(body.signature[2:]))
        except ClaimRejected as e:
            log.info("claim rejected (%s) key=%s ip=%s: %s", e.kind, body.claimKey, ip, e.reason)
            raise HTTPException(HTTP_STATUS[e.kind], e.reason) from None

        return {
            "txHash": result.tx_hash,
            "claimKey": result.claim_key,
            "recipient": result.recipient,
            "amount": result.amount,
            "fee": result.fee,
        }

    if indexer is not None:
        _add_dashboard_routes(app, relayer, indexer, admin_token, read_limit, client_ip)

    if circle is not None:
        # Money sent to these addresses is lost or stuck, so refuse them up front.
        unsafe = {"0x0000000000000000000000000000000000000000", ARC_USDC.lower(), relayer.contract.address.lower()}
        _add_circle_routes(app, circle, RateLimiter(10, 60), client_ip, unsafe)

    return app


def _add_circle_routes(app: FastAPI, circle: CircleClient, limit: RateLimiter, client_ip, unsafe: set[str]) -> None:
    def call(request: Request, fn, *args):
        if not limit.allow(client_ip(request)):
            raise HTTPException(429, "too many requests")
        try:
            return fn(*args)
        except CircleError as e:
            log.warning("circle error %s (%s): %s", e.status, e.code, e.message)
            raise HTTPException(502 if e.status >= 500 else 400, e.message) from None

    @app.post("/circle/social-token")
    def social_token(body: DeviceRequest, request: Request):
        return call(request, circle.social_device_token, body.deviceId)

    @app.post("/circle/email-token")
    def email_token(body: EmailRequest, request: Request):
        return call(request, circle.email_device_token, body.deviceId, body.email)

    @app.post("/circle/wallet")
    def wallet(body: UserRequest, request: Request):
        """First call may return a challengeId the SDK must execute; call again afterwards for the address."""
        challenge_id = call(request, circle.initialize_user, body.userToken)
        if challenge_id:
            return {"challengeId": challenge_id, "address": None}
        addresses = call(request, circle.wallet_addresses, body.userToken)
        return {"challengeId": None, "address": addresses[0] if addresses else None}

    @app.post("/circle/transfer")
    def transfer(body: TransferRequest, request: Request):
        if body.destinationAddress.lower() in unsafe:
            raise HTTPException(400, "that address can't receive transfers; money sent there would be lost")
        if Decimal(body.amount) <= 0:
            raise HTTPException(400, "amount must be more than zero")
        challenge_id = call(request, circle.create_transfer, body.userToken, body.destinationAddress, body.amount)
        return {"challengeId": challenge_id}


def _add_dashboard_routes(app: FastAPI, relayer: Relayer, indexer: Indexer, admin_token: str | None,
                          limit: RateLimiter, client_ip) -> None:
    ix: Index = indexer.index

    def throttle(request: Request):
        if not limit.allow(client_ip(request)):
            raise HTTPException(429, "too many requests")

    def freshness() -> dict:
        return {"indexedBlock": indexer.last_block}

    @app.get("/stats/public")
    def public_stats(request: Request):
        throttle(request)
        return {**stats.public_totals(ix), **freshness()}

    @app.get("/organizers/{address}/campaigns")
    def organizer_campaigns(address: str, request: Request):
        throttle(request)
        if not Web3.is_address(address):
            raise HTTPException(400, "bad address")
        owner = Web3.to_checksum_address(address)
        return {"campaigns": stats.campaigns(ix, owner=owner), **freshness()}

    @app.get("/campaigns/{campaign_id}")
    def campaign_detail(campaign_id: int, request: Request):
        throttle(request)
        detail = stats.campaign(ix, campaign_id)
        if detail is None:
            raise HTTPException(404, "no such campaign (or not indexed yet)")
        return {**detail, **freshness()}

    @app.get("/admin/overview")
    def admin_overview(request: Request, authorization: str = Header(default="")):
        throttle(request)
        token = authorization.removeprefix("Bearer ").strip()
        if not admin_token or not hmac.compare_digest(token, admin_token):
            raise HTTPException(401, "admin token required")
        balance = relayer.balance()
        return {
            "totals": stats.totals(ix),
            "claimsByDay": stats.claims_by_day(ix, days=30),
            "campaigns": stats.campaigns(ix),
            "recentClaims": stats.recent_claims(ix, limit=20),
            "relayer": {
                "address": relayer.address,
                "balanceUsdc": balance / 10**NATIVE_DECIMALS,
                "lowBalance": balance < relayer.min_balance,
                "claimCost": relayer.claim_cost(),
            },
            "contract": relayer.contract.address,
            "chainId": relayer.chain_id,
            **freshness(),
        }
