"""Arc network constants.

Sources: https://docs.arc.io/arc/concepts/stablecoin-native-model
         https://docs.arc.io/arc/references/evm-differences.md
"""

ARC_MAINNET_CHAIN_ID = 5042
ARC_MAINNET_RPC = "https://rpc.mainnet.arc.io"

# USDC's ERC-20 interface on Arc (6 decimals). It shares one balance with native USDC,
# which uses 18 decimals for gas and msg.value.
ARC_USDC = "0x3600000000000000000000000000000000000000"
USDC_DECIMALS = 6
NATIVE_DECIMALS = 18

# The mempool silently drops transactions with maxFeePerGas below 20 gwei.
MIN_MAX_FEE_PER_GAS = 20 * 10**9


def usdc(amount: float | str) -> int:
    """Human dollars -> 6-decimal USDC units. usdc("10.50") == 10_500_000."""
    from decimal import Decimal

    return int(Decimal(str(amount)) * 10**USDC_DECIMALS)


def native_to_usdc_units(wei: int) -> int:
    """18-decimal native USDC (e.g. a gas cost) -> 6-decimal ERC-20 units, rounded up."""
    scale = 10 ** (NATIVE_DECIMALS - USDC_DECIMALS)
    return -(-wei // scale)
