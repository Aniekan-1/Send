"""Run the whole app locally with fake USDC: no real money, no Arc needed.

    uv run python scripts/local_stack.py          # then, in web/:  npm run dev

Starts anvil (a local blockchain), deploys a mock USDC at Arc's real USDC address and DollarDrop,
gives the test organizer 1,000 mock USDC, writes web/.env.local, and runs the relayer on :8000.

Test wallets (anvil's well-known dev keys; never use them anywhere real):
    organizer  0xf39F…2266   import key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
"""

import argparse
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import uvicorn
from eth_account import Account
from web3 import Web3

from dollardrop.arc import ARC_USDC, usdc
from dollardrop.compile import compile_all
from dollardrop.indexer import Index, Indexer
from dollardrop.relayer.app import create_app
from dollardrop.relayer.core import Relayer

ROOT = Path(__file__).resolve().parent.parent
ANVIL_KEYS = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",  # organizer
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",  # relayer
]
CHAIN_ID = 31337


def find_anvil() -> str:
    local = ROOT / ".tools" / "foundry" / ("anvil.exe" if os.name == "nt" else "anvil")
    found = str(local) if local.exists() else shutil.which("anvil")
    if not found:
        sys.exit("anvil not found: install Foundry (https://getfoundry.sh) or put it in .tools/foundry/")
    return found


def require_free(port: int) -> None:
    with socket.socket() as sock:
        if sock.connect_ex(("127.0.0.1", port)) == 0:
            sys.exit(f"port {port} is already in use (an old local stack still running?); stop it and retry")


def start_anvil(port: int) -> subprocess.Popen:
    proc = subprocess.Popen(
        [find_anvil(), "--port", str(port), "--chain-id", str(CHAIN_ID), "--silent"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    w3 = Web3(Web3.HTTPProvider(f"http://127.0.0.1:{port}"))
    for _ in range(50):
        if w3.is_connected():
            return proc
        time.sleep(0.1)
    proc.kill()
    sys.exit("anvil did not start")


def send(w3: Web3, account, fn) -> dict:
    tx = fn.build_transaction({"from": account.address, "nonce": w3.eth.get_transaction_count(account.address)})
    receipt = w3.eth.wait_for_transaction_receipt(
        w3.eth.send_raw_transaction(account.sign_transaction(tx).raw_transaction)
    )
    assert receipt.status == 1, receipt
    return receipt


def deploy(w3: Web3, account, artifact: dict, *args):
    factory = w3.eth.contract(abi=artifact["abi"], bytecode=artifact["bytecode"])
    receipt = send(w3, account, factory.constructor(*args))
    return w3.eth.contract(address=receipt.contractAddress, abi=artifact["abi"]), receipt.blockNumber


def setup(w3: Web3) -> tuple:
    organizer, relayer_acct = (Account.from_key(k) for k in ANVIL_KEYS)
    artifacts = compile_all()

    # Put mock USDC at Arc's real USDC address, so the web pages need no special casing.
    mock, _ = deploy(w3, organizer, artifacts["MockUSDC"])
    w3.provider.make_request("anvil_setCode", [ARC_USDC, w3.eth.get_code(mock.address).hex()])
    usdc_token = w3.eth.contract(address=Web3.to_checksum_address(ARC_USDC), abi=artifacts["MockUSDC"]["abi"])
    send(w3, organizer, usdc_token.functions.mint(organizer.address, usdc(1_000)))

    dd, block = deploy(w3, organizer, artifacts["DollarDrop"], usdc_token.address)
    return organizer, relayer_acct, usdc_token, dd, block


def write_web_env(rpc: str, contract: str, block: int, relayer_url: str) -> Path:
    path = ROOT / "web" / ".env.local"
    path.write_text(
        "# Written by scripts/local_stack.py; overrides web/.env while it exists. Delete to use real settings.\n"
        f"VITE_CHAIN_ID={CHAIN_ID}\nVITE_RPC_URL={rpc}\nVITE_DOLLARDROP_ADDRESS={contract}\n"
        f"VITE_DEPLOY_BLOCK={block}\nVITE_RELAYER_URL={relayer_url}\n"
    )
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--anvil-port", type=int, default=8545)
    parser.add_argument("--relayer-port", type=int, default=8000)
    args = parser.parse_args()

    require_free(args.anvil_port)
    require_free(args.relayer_port)
    anvil = start_anvil(args.anvil_port)
    try:
        rpc = f"http://127.0.0.1:{args.anvil_port}"
        w3 = Web3(Web3.HTTPProvider(rpc))
        organizer, relayer_acct, _, dd, block = setup(w3)
        relayer_url = f"http://127.0.0.1:{args.relayer_port}"
        env_path = write_web_env(rpc, dd.address, block, relayer_url)

        print(f"""
local chain   {rpc} (chain id {CHAIN_ID})
DollarDrop    {dd.address}
mock USDC     {ARC_USDC}
organizer     {organizer.address}  (1,000 mock USDC; import its key into your wallet, see docstring)
relayer       {relayer_url}  as {relayer_acct.address}
web config    {env_path.relative_to(ROOT)}

next: cd web && npm run dev     then open http://localhost:5173/organize.html
""")
        indexer = Indexer(w3, dd, Index(), from_block=block)  # in memory: the local chain is throwaway too
        indexer.start_background(interval=2)
        app = create_app(
            Relayer(w3, dd, relayer_acct),
            cors_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
            indexer=indexer,
            admin_token="local-admin",  # operator dashboard on the local stack
        )
        uvicorn.run(app, host="127.0.0.1", port=args.relayer_port, log_level="warning")
    finally:
        anvil.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
