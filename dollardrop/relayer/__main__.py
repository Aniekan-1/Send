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
from dollardrop.compile import load
from dollardrop.relayer.app import create_app
from dollardrop.relayer.core import Relayer

ROOT = Path(__file__).resolve().parents[2]


def _contract_address(chain_id: int) -> str | None:
    if address := os.environ.get("DOLLARDROP_ADDRESS"):
        return address
    for record in (ROOT / "deployments").glob("*.json"):
        data = json.loads(record.read_text())
        if data.get("chainId") == chain_id:
            return data["address"]
    return None


def main() -> int:
    load_dotenv(ROOT / ".env")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    key = os.environ.get("RELAYER_PRIVATE_KEY")
    if not key:
        print("RELAYER_PRIVATE_KEY is not set (see .env.example)", file=sys.stderr)
        return 1

    w3 = Web3(Web3.HTTPProvider(os.environ.get("ARC_RPC_URL") or ARC_MAINNET_RPC))
    address = _contract_address(w3.eth.chain_id)
    if not address:
        print("no DollarDrop deployment found; set DOLLARDROP_ADDRESS or run scripts/deploy.py", file=sys.stderr)
        return 1

    contract = w3.eth.contract(address=Web3.to_checksum_address(address), abi=load("DollarDrop")["abi"])
    # min balance is native USDC (18 decimals); usdc() gives 6 decimals, so scale up.
    min_balance = usdc(os.environ.get("MIN_RELAYER_BALANCE_USDC") or "1") * 10**12
    relayer = Relayer(w3, contract, Account.from_key(key), min_balance=min_balance)

    origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
    circle = None
    if circle_key := os.environ.get("CIRCLE_API_KEY"):
        circle = CircleClient(circle_key, BLOCKCHAINS[relayer.chain_id])
    app = create_app(relayer, cors_origins=origins, circle=circle)

    logging.getLogger(__name__).info("relayer %s for DollarDrop %s on chain %s", relayer.address, address, relayer.chain_id)
    uvicorn.run(app, host=os.environ.get("HOST") or "127.0.0.1", port=int(os.environ.get("PORT") or "8000"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
