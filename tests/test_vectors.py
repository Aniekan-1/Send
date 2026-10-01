"""Python half of the cross-language check; web/src/eip712.test.ts is the TypeScript half."""

import json
from pathlib import Path

from dollardrop import claims

VECTOR = json.loads((Path(__file__).parent / "vectors" / "claim-signature.json").read_text())


def test_claim_key_address_matches_vector():
    assert claims.claim_key_from_secret(VECTOR["claimKeySecret"]).address == VECTOR["claimKeyAddress"]


def test_claim_signature_matches_vector():
    sig = claims.sign_claim(
        VECTOR["claimKeySecret"],
        chain_id=VECTOR["chainId"],
        contract=VECTOR["contract"],
        recipient=VECTOR["recipient"],
        relayer=VECTOR["relayer"],
        fee=VECTOR["fee"],
    )
    assert "0x" + sig.hex() == VECTOR["signature"]
