"""Create and fund drops from the command line (the organizer page, as a script).

    uv run python scripts/create_drops.py --amount 1 --count 1             # dry run
    uv run python scripts/create_drops.py --amount 1 --count 1 --yes       # fund for real

Claim keys are generated here and written to drops/<date>-<n>.csv BEFORE any money moves.
That file is the only copy of the links: keep it private (drops/ is git-ignored).
The paying wallet's key comes from .env (ORGANIZER_PRIVATE_KEY by default; see --key-env).
"""

import argparse
import base64
import csv
import json
import os
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from dotenv import load_dotenv
from eth_account import Account
from web3 import Web3
from web3.logs import DISCARD

from dollardrop import claims
from dollardrop.arc import ARC_MAINNET_RPC, ARC_USDC, MIN_MAX_FEE_PER_GAS, usdc
from dollardrop.compile import load

ROOT = Path(__file__).resolve().parent.parent
ERC20 = [
    {"name": "balanceOf", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "a", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "allowance", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "o", "type": "address"}, {"name": "s", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "approve", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "s", "type": "address"}, {"name": "v", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}]},
]


def claim_link(site: str, private_key: str) -> str:
    secret = base64.urlsafe_b64encode(bytes.fromhex(private_key[2:])).decode().rstrip("=")
    return f"{site.rstrip('/')}/claim.html#k={secret}"


def send(w3: Web3, account, fn) -> dict:
    tx = fn.build_transaction({
        "from": account.address,
        "nonce": w3.eth.get_transaction_count(account.address, "pending"),
        "maxFeePerGas": max(2 * w3.eth.gas_price, MIN_MAX_FEE_PER_GAS),
        "maxPriorityFeePerGas": 0,
    })
    receipt = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(account.sign_transaction(tx).raw_transaction))
    if receipt.status != 1:
        sys.exit(f"transaction failed: 0x{bytes(receipt.transactionHash).hex()}")
    return receipt


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--amount", required=True, help="dollars per drop, e.g. 1 or 2.50")
    p.add_argument("--count", type=int, default=1)
    p.add_argument("--days", type=float, default=7, help="claim deadline, days from now")
    p.add_argument("--fee-cap", default="0.05", help="max network fee per claim, dollars")
    p.add_argument("--site", default="http://localhost:5173", help="where claim.html is served")
    p.add_argument("--key-env", default="ORGANIZER_PRIVATE_KEY", help=".env variable holding the paying wallet's key")
    p.add_argument("--yes", action="store_true", help="actually fund the drops")
    args = p.parse_args()

    load_dotenv(ROOT / ".env")
    key = os.environ.get(args.key_env)
    if not key:
        sys.exit(f"{args.key_env} is not set in .env")
    payer = Account.from_key(key)

    w3 = Web3(Web3.HTTPProvider(os.environ.get("ARC_RPC_URL") or ARC_MAINNET_RPC))
    deployment = next(
        (json.loads(f.read_text()) for f in (ROOT / "deployments").glob("*.json")
         if json.loads(f.read_text())["chainId"] == w3.eth.chain_id),
        None,
    )
    if not deployment:
        sys.exit(f"no DollarDrop deployment recorded for chain {w3.eth.chain_id}")
    dd = w3.eth.contract(address=deployment["address"], abi=load("DollarDrop")["abi"])
    token = w3.eth.contract(address=Web3.to_checksum_address(ARC_USDC), abi=ERC20)

    amount, fee_cap = usdc(args.amount), usdc(args.fee_cap)
    total = amount * args.count
    expires_at = int(time.time() + args.days * 86400)
    balance = token.functions.balanceOf(payer.address).call()

    print(f"network     {deployment['network']}  contract {dd.address}")
    print(f"payer       {payer.address}  ({Decimal(balance) / 10**6} USDC)")
    print(f"drops       {args.count} x ${Decimal(amount) / 10**6} = ${Decimal(total) / 10**6}, fee cap ${Decimal(fee_cap) / 10**6}")
    print(f"deadline    {datetime.fromtimestamp(expires_at, timezone.utc):%Y-%m-%d %H:%M} UTC")
    if balance < total:
        sys.exit("not enough USDC")
    if not args.yes:
        print("\ndry run only; re-run with --yes to fund")
        return 0

    # 1. Keys and backup first: if anything below fails, nothing is lost.
    keys = [claims.new_claim_key() for _ in range(args.count)]
    out_dir = ROOT / "drops"
    out_dir.mkdir(exist_ok=True)
    backup = out_dir / f"{datetime.now():%Y%m%d-%H%M%S}-{args.count}x{args.amount}.csv"
    with backup.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["drop", "amount_usd", "claim_key", "link"])
        for i, k in enumerate(keys, 1):
            writer.writerow([i, args.amount, k.address, claim_link(args.site, k.private_key)])
    print(f"\nbackup      {backup.relative_to(ROOT)}  (private: anyone with a link can claim it)")

    # 2. Approve (if needed) and fund.
    if token.functions.allowance(payer.address, dd.address).call() < total:
        send(w3, payer, token.functions.approve(dd.address, total))
        print("approved    USDC for DollarDrop")
    receipt = send(w3, payer, dd.functions.createCampaign(amount, expires_at, fee_cap, [k.address for k in keys]))
    (event,) = dd.events.CampaignCreated().process_receipt(receipt, errors=DISCARD)
    print(f"funded      campaign #{event.args.campaignId}  tx 0x{bytes(receipt.transactionHash).hex()}")
    for i, k in enumerate(keys, 1):
        print(f"link {i}      {claim_link(args.site, k.private_key)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
