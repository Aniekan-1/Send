"""Deploy DollarDrop to Arc.

    uv run python scripts/deploy.py            # dry run: checks chain, balance, gas estimate
    uv run python scripts/deploy.py --yes      # actually deploys (spends USDC on gas)

Reads from .env (see .env.example):
    DEPLOYER_PRIVATE_KEY  key of the deploying wallet (needs a little USDC on Arc for gas)
    ARC_RPC_URL           optional, defaults to Arc mainnet
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from eth_account import Account
from web3 import Web3

from dollardrop.arc import ARC_MAINNET_RPC, ARC_USDC, MIN_MAX_FEE_PER_GAS, NATIVE_DECIMALS
from dollardrop.compile import compile_all

ROOT = Path(__file__).resolve().parent.parent
NETWORKS = {5042: "arc-mainnet", 5042002: "arc-testnet"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--yes", action="store_true", help="send the deployment transaction")
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")
    key = os.environ.get("DEPLOYER_PRIVATE_KEY")
    if not key:
        print("DEPLOYER_PRIVATE_KEY is not set (see .env.example)", file=sys.stderr)
        return 1

    w3 = Web3(Web3.HTTPProvider(os.environ.get("ARC_RPC_URL", ARC_MAINNET_RPC)))
    chain_id = w3.eth.chain_id
    network = NETWORKS.get(chain_id)
    if network is None:
        print(f"refusing to deploy: chain id {chain_id} is not Arc", file=sys.stderr)
        return 1

    deployer = Account.from_key(key)
    native_balance = w3.eth.get_balance(deployer.address)
    print(f"network        {network} (chain id {chain_id})")
    print(f"deployer       {deployer.address}")
    print(f"balance        {native_balance / 10**NATIVE_DECIMALS:.6f} USDC")
    if native_balance == 0:
        print("deployer has no USDC on Arc; fund it first (gas is paid in USDC)", file=sys.stderr)
        return 1

    artifact = compile_all()["DollarDrop"]
    factory = w3.eth.contract(abi=artifact["abi"], bytecode=artifact["bytecode"])

    max_fee = max(2 * w3.eth.gas_price, MIN_MAX_FEE_PER_GAS)
    tx = factory.constructor(ARC_USDC).build_transaction(
        {
            "from": deployer.address,
            "nonce": w3.eth.get_transaction_count(deployer.address),
            "maxFeePerGas": max_fee,
            "maxPriorityFeePerGas": 0,
            "chainId": chain_id,
        }
    )
    worst_case = tx["gas"] * max_fee

    print(f"gas estimate   {tx['gas']:,} gas, at most {worst_case / 10**NATIVE_DECIMALS:.6f} USDC")
    print(f"constructor    usdc = {ARC_USDC}")

    if native_balance < worst_case:
        print("not enough USDC for gas", file=sys.stderr)
        return 1
    if not args.yes:
        print("\ndry run only; re-run with --yes to deploy")
        return 0

    tx_hash = w3.eth.send_raw_transaction(deployer.sign_transaction(tx).raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    if receipt.status != 1:
        print(f"deployment failed: {tx_hash.hex()}", file=sys.stderr)
        return 1

    record = {
        "network": network,
        "chainId": chain_id,
        "address": receipt.contractAddress,
        "usdc": ARC_USDC,
        "txHash": "0x" + bytes(tx_hash).hex(),
        "block": receipt.blockNumber,
        "deployer": deployer.address,
        "deployedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    out = ROOT / "deployments" / f"{network}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(record, indent=2) + "\n")
    print(f"\ndeployed DollarDrop at {receipt.contractAddress}\nsaved {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
