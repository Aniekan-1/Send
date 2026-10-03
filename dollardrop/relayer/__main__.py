"""Start the relayer from environment settings (see .env.example).

    uv run python -m dollardrop.relayer
"""

import json
import logging
import os
import sys
from pathlib import Path

import uvicorn
from dotenv import load_dotenv
from eth_account import Account
from web3 import Web3

from dollardrop.arc import ARC_MAINNET_RPC, usdc
from dollardrop.circle import BLOCKCHAINS, CircleClient
from dollardrop.indexer import Index, Indexer
from dollardrop.compile import load
from dollardrop.relayer.app import create_app
from dollardrop.relayer.core import Relayer

ROOT = Path(__file__).resolve().parents[2]


def _deployment(chain_id: int) -> dict | None:
    """{"address", "block"}: DOLLARDROP_ADDRESS from .env wins, else deployments/<network>.json."""
    record = next(
        (json.loads(f.read_text()) for f in (ROOT / "deployments").glob("*.json")
         if json.loads(f.read_text()).get("chainId") == chain_id),
        None,
    )
    if address := os.environ.get("DOLLARDROP_ADDRESS"):
        same = record and record["address"].lower() == address.lower()
        return {"address": address, "block": record["block"] if same else int(os.environ.get("DEPLOY_BLOCK") or 0)}
    return record


def main() -> int:
    load_dotenv(ROOT / ".env")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    key = os.environ.get("RELAYER_PRIVATE_KEY")
    if not key:
        print("RELAYER_PRIVATE_KEY is not set (see .env.example)", file=sys.stderr)
        return 1

    w3 = Web3(Web3.HTTPProvider(os.environ.get("ARC_RPC_URL") or ARC_MAINNET_RPC))
    deployment = _deployment(w3.eth.chain_id)
    if not deployment:
        print("no DollarDrop deployment found; set DOLLARDROP_ADDRESS or run scripts/deploy.py", file=sys.stderr)
        return 1

    address = deployment["address"]
    contract = w3.eth.contract(address=Web3.to_checksum_address(address), abi=load("DollarDrop")["abi"])
    # min balance is native USDC (18 decimals); usdc() gives 6 decimals, so scale up.
    min_balance = usdc(os.environ.get("MIN_RELAYER_BALANCE_USDC") or "1") * 10**12
    relayer = Relayer(w3, contract, Account.from_key(key), min_balance=min_balance)

    origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
    circle = None
    if circle_key := os.environ.get("CIRCLE_API_KEY"):
        circle = CircleClient(circle_key, BLOCKCHAINS[relayer.chain_id])
    # Event index for the dashboards. Delete the file to rebuild it from the chain.
    index = Index(ROOT / "data" / f"index-{relayer.chain_id}.sqlite")
    indexer = Indexer(w3, contract, index, from_block=deployment["block"])
    indexer.start_background(interval=5)

    admin_token = os.environ.get("ADMIN_TOKEN") or None
    if not admin_token:
        logging.getLogger(__name__).warning("ADMIN_TOKEN not set; the operator dashboard is disabled")
    app = create_app(relayer, cors_origins=origins, circle=circle, indexer=indexer, admin_token=admin_token)

    logging.getLogger(__name__).info("relayer %s for DollarDrop %s on chain %s", relayer.address, address, relayer.chain_id)
    uvicorn.run(app, host=os.environ.get("HOST") or "127.0.0.1", port=int(os.environ.get("PORT") or "8000"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
