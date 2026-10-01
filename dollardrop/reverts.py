"""Turn contract reverts into readable error names (e.g. "BadSignature")."""

import ast
import re

from eth_utils import keccak
from web3.exceptions import ContractCustomError

# eth-tester's eth_call/estimateGas only keeps the revert bytes inside its message text.
_BYTES_IN_MESSAGE = re.compile(r"execution reverted: (b'.*'|b\".*\")$", re.DOTALL)


def revert_data(exc: BaseException | None) -> str | None:
    """Raw revert bytes as 0x-hex, from a web3 ContractCustomError or eth-tester's wrapped py-evm Revert."""
    while exc is not None:
        if isinstance(exc, ContractCustomError):
            return exc.data if isinstance(exc.data, str) else "0x" + exc.data.hex()
        if type(exc).__name__ == "Revert" and exc.args and isinstance(exc.args[0], bytes):
            return "0x" + exc.args[0].hex()
        # eth-tester's eth_call/estimateGas only keeps the bytes inside the message: "execution reverted: b'...'"
        if match := _BYTES_IN_MESSAGE.search(str(exc)):
            return "0x" + ast.literal_eval(match.group(1)).hex()
        exc = exc.__cause__ or exc.__context__
    return None


def error_selectors(abi: list[dict]) -> dict[str, str]:
    """{"0x1234abcd": "ErrorName"} for every custom error in an ABI."""
    out = {}
    for item in abi:
        if item["type"] == "error":
            sig = f"{item['name']}({','.join(i['type'] for i in item['inputs'])})"
            out["0x" + keccak(text=sig)[:4].hex()] = item["name"]
    return out


def error_name(abi: list[dict], exc: BaseException) -> str | None:
    data = revert_data(exc)
    if not data:
        return None
    return error_selectors(abi).get(data[:10])
