import pytest
from web3.logs import DISCARD

from dollardrop import claims
from dollardrop.arc import usdc
from dollardrop.claims import ZERO_ADDRESS

from conftest import DAY

ACTIVE, CLAIMED, REFUNDED = 1, 2, 3


def balance(token, who):
    return token.functions.balanceOf(who).call()


# ------------------------------------------------------------------ happy paths


def test_create_campaign_locks_funds(dd, token, accounts, create_campaign):
    before = balance(token, accounts["organizer"])
    campaign_id, keys = create_campaign(n=3, amount=usdc(10))

    assert campaign_id == 1
    assert balance(token, dd.address) == usdc(30)
    assert balance(token, accounts["organizer"]) == before - usdc(30)
    for k in keys:
        cid, status, amount, _, fee_cap, paused = dd.functions.getDrop(k.address).call()
        assert (cid, status, amount, fee_cap, paused) == (1, ACTIVE, usdc(10), usdc("0.05"), False)


def test_relayer_claim_pays_fee_out_of_drop(dd, token, accounts, create_campaign, sign):
    _, keys = create_campaign(amount=usdc(10))
    alice, relayer = accounts["alice"], accounts["relayer"]
    fee = usdc("0.01")

    sig = sign(keys[0], alice, relayer, fee)
    tx = dd.functions.claim(keys[0].address, alice, relayer, fee, sig).transact({"from": relayer})

    assert balance(token, alice) == usdc(10) - fee
    assert balance(token, relayer) == fee
    assert dd.functions.getDrop(keys[0].address).call()[1] == CLAIMED
    assert dd.functions.hasClaimed(1, alice).call()

    (event,) = dd.events.Claimed().process_receipt(dd.w3.eth.get_transaction_receipt(tx), errors=DISCARD)
    assert event.args.recipient == alice
    assert event.args.relayer == relayer
    assert event.args.amount == usdc(10) - fee
    assert event.args.fee == fee


def test_recipient_can_claim_directly_without_fee(dd, token, accounts, create_campaign, sign):
    _, keys = create_campaign(amount=usdc(10))
    alice = accounts["alice"]

    sig = sign(keys[0], alice, ZERO_ADDRESS, 0)
    dd.functions.claim(keys[0].address, alice, ZERO_ADDRESS, 0, sig).transact({"from": alice})

    assert balance(token, alice) == usdc(10)


def test_python_digest_matches_contract(w3, dd, accounts, create_campaign, sign):
    """claims.py and DollarDrop.sol must agree on the EIP-712 encoding, or no claim ever works."""
    _, keys = create_campaign()
    alice, relayer = accounts["alice"], accounts["relayer"]
    sig = sign(keys[0], alice, relayer, 123)

    recovered = claims.recover_claim_signer(
        sig, chain_id=w3.eth.chain_id, contract=dd.address, recipient=alice, relayer=relayer, fee=123
    )
    assert recovered == keys[0].address

    digest = dd.functions.claimDigest(alice, relayer, 123).call()
    from eth_account import Account

    assert Account._recover_hash(digest, signature=sig) == keys[0].address


# ------------------------------------------------------------------ front-running / signature abuse


def test_copied_signature_cannot_change_recipient(dd, accounts, create_campaign, sign, reverts):
    _, keys = create_campaign()
    alice, relayer, mallory = accounts["alice"], accounts["relayer"], accounts["mallory"]
    sig = sign(keys[0], alice, relayer, 0)

    with reverts(dd, "BadSignature"):
        dd.functions.claim(keys[0].address, mallory, relayer, 0, sig).transact({"from": relayer})


def test_copied_claim_cannot_be_submitted_by_someone_else(dd, accounts, create_campaign, sign, reverts):
    _, keys = create_campaign()
    alice, relayer, mallory = accounts["alice"], accounts["relayer"], accounts["mallory"]
    fee = usdc("0.01")
    sig = sign(keys[0], alice, relayer, fee)

    with reverts(dd, "WrongRelayer"):
        dd.functions.claim(keys[0].address, alice, relayer, fee, sig).transact({"from": mallory})


def test_open_relayer_copy_still_pays_the_recipient(dd, token, accounts, create_campaign, sign):
    """relayer=0 lets anyone submit; a copier can only take the signed fee, never the drop."""
    _, keys = create_campaign(amount=usdc(10))
    alice, mallory = accounts["alice"], accounts["mallory"]
    fee = usdc("0.02")
    sig = sign(keys[0], alice, ZERO_ADDRESS, fee)

    dd.functions.claim(keys[0].address, alice, ZERO_ADDRESS, fee, sig).transact({"from": mallory})

    assert balance(token, alice) == usdc(10) - fee
    assert balance(token, mallory) == fee


def test_fee_cannot_be_raised_after_signing(dd, accounts, create_campaign, sign, reverts):
    _, keys = create_campaign()
    alice, relayer = accounts["alice"], accounts["relayer"]
    sig = sign(keys[0], alice, relayer, usdc("0.01"))

    with reverts(dd, "BadSignature"):
        dd.functions.claim(keys[0].address, alice, relayer, usdc("0.05"), sig).transact({"from": relayer})


def test_fee_above_campaign_cap_rejected(dd, accounts, create_campaign, sign, reverts):
    _, keys = create_campaign(fee_cap=usdc("0.05"))
    alice, relayer = accounts["alice"], accounts["relayer"]
    fee = usdc("0.06")
    sig = sign(keys[0], alice, relayer, fee)

    with reverts(dd, "FeeTooHigh"):
        dd.functions.claim(keys[0].address, alice, relayer, fee, sig).transact({"from": relayer})


def test_signature_from_wrong_key_rejected(dd, accounts, create_campaign, sign, reverts):
    _, keys = create_campaign(n=2)
    alice, relayer = accounts["alice"], accounts["relayer"]
    sig = sign(keys[1], alice, relayer, 0)  # signed by drop #2's key, used on drop #1

    with reverts(dd, "BadSignature"):
        dd.functions.claim(keys[0].address, alice, relayer, 0, sig).transact({"from": relayer})


def test_signature_for_other_chain_rejected(dd, accounts, create_campaign, sign, reverts):
    _, keys = create_campaign()
    alice, relayer = accounts["alice"], accounts["relayer"]
    sig = sign(keys[0], alice, relayer, 0, chain_id=5042)  # Arc mainnet, not this test chain

    with reverts(dd, "BadSignature"):
        dd.functions.claim(keys[0].address, alice, relayer, 0, sig).transact({"from": relayer})


def test_signature_for_other_contract_rejected(dd, accounts, create_campaign, sign, reverts):
    _, keys = create_campaign()
    alice, relayer = accounts["alice"], accounts["relayer"]
    sig = sign(keys[0], alice, relayer, 0, contract="0x000000000000000000000000000000000000dEaD")

    with reverts(dd, "BadSignature"):
        dd.functions.claim(keys[0].address, alice, relayer, 0, sig).transact({"from": relayer})


def test_zero_recipient_rejected(dd, accounts, create_campaign, sign, reverts):
    _, keys = create_campaign()
    relayer = accounts["relayer"]
    sig = sign(keys[0], ZERO_ADDRESS, relayer, 0)

    with reverts(dd, "InvalidRecipient"):
        dd.functions.claim(keys[0].address, ZERO_ADDRESS, relayer, 0, sig).transact({"from": relayer})


# ------------------------------------------------------------------ one-time use / one per wallet


def test_drop_cannot_be_claimed_twice(dd, accounts, create_campaign, sign, reverts):
    _, keys = create_campaign()
    alice, bob, relayer = accounts["alice"], accounts["bob"], accounts["relayer"]
    dd.functions.claim(keys[0].address, alice, relayer, 0, sign(keys[0], alice, relayer, 0)).transact(
        {"from": relayer}
    )

    with reverts(dd, "DropNotActive"):
        dd.functions.claim(keys[0].address, bob, relayer, 0, sign(keys[0], bob, relayer, 0)).transact(
            {"from": relayer}
        )


def test_one_claim_per_wallet_per_campaign(dd, accounts, create_campaign, sign, reverts):
    _, keys = create_campaign(n=2)
    alice, relayer = accounts["alice"], accounts["relayer"]
    dd.functions.claim(keys[0].address, alice, relayer, 0, sign(keys[0], alice, relayer, 0)).transact(
        {"from": relayer}
    )

    with reverts(dd, "AlreadyClaimed"):
        dd.functions.claim(keys[1].address, alice, relayer, 0, sign(keys[1], alice, relayer, 0)).transact(
            {"from": relayer}
        )


def test_same_wallet_can_claim_in_different_campaigns(dd, token, accounts, create_campaign, sign):
    _, keys_a = create_campaign(n=1, amount=usdc(5))
    _, keys_b = create_campaign(n=1, amount=usdc(7))
    alice, relayer = accounts["alice"], accounts["relayer"]

    for k in (keys_a[0], keys_b[0]):
        dd.functions.claim(k.address, alice, relayer, 0, sign(k, alice, relayer, 0)).transact({"from": relayer})

    assert balance(token, alice) == usdc(12)


def test_unknown_claim_key_rejected(dd, accounts, sign, reverts):
    stranger = claims.new_claim_key()
    alice, relayer = accounts["alice"], accounts["relayer"]

    with reverts(dd, "DropNotActive"):
        dd.functions.claim(stranger.address, alice, relayer, 0, sign(stranger, alice, relayer, 0)).transact(
            {"from": relayer}
        )


# ------------------------------------------------------------------ expiry, pause, refund


def test_claim_after_expiry_rejected(dd, accounts, create_campaign, sign, reverts, time_travel):
    _, keys = create_campaign(expires_in=DAY)
    alice, relayer = accounts["alice"], accounts["relayer"]
    time_travel(DAY + 1)

    with reverts(dd, "CampaignExpired"):
        dd.functions.claim(keys[0].address, alice, relayer, 0, sign(keys[0], alice, relayer, 0)).transact(
            {"from": relayer}
        )


def test_paused_campaign_blocks_claims_until_resumed(dd, token, accounts, create_campaign, sign, reverts):
    campaign_id, keys = create_campaign()
    alice, relayer, organizer = accounts["alice"], accounts["relayer"], accounts["organizer"]
    sig = sign(keys[0], alice, relayer, 0)

    dd.functions.setPaused(campaign_id, True).transact({"from": organizer})
    with reverts(dd, "CampaignPaused"):
        dd.functions.claim(keys[0].address, alice, relayer, 0, sig).transact({"from": relayer})

    dd.functions.setPaused(campaign_id, False).transact({"from": organizer})
    dd.functions.claim(keys[0].address, alice, relayer, 0, sig).transact({"from": relayer})
    assert balance(token, alice) == usdc(10)


def test_only_owner_can_pause(dd, accounts, create_campaign, reverts):
    campaign_id, _ = create_campaign()
    with reverts(dd, "NotCampaignOwner"):
        dd.functions.setPaused(campaign_id, True).transact({"from": accounts["mallory"]})


def test_owner_refunds_unclaimed_drops(dd, token, accounts, create_campaign, sign, reverts):
    _, keys = create_campaign(n=3, amount=usdc(10))
    alice, relayer, organizer = accounts["alice"], accounts["relayer"], accounts["organizer"]
    dd.functions.claim(keys[0].address, alice, relayer, 0, sign(keys[0], alice, relayer, 0)).transact(
        {"from": relayer}
    )
    before = balance(token, organizer)

    dd.functions.refund([keys[1].address, keys[2].address]).transact({"from": organizer})

    assert balance(token, organizer) == before + usdc(20)
    assert balance(token, dd.address) == 0
    assert dd.functions.getDrop(keys[1].address).call()[1] == REFUNDED

    with reverts(dd, "DropNotActive"):  # refunded drops can't be claimed
        dd.functions.claim(keys[1].address, accounts["bob"], relayer, 0, sign(keys[1], accounts["bob"], relayer, 0)).transact(
            {"from": relayer}
        )


def test_refund_works_after_expiry(dd, token, accounts, create_campaign, time_travel):
    _, keys = create_campaign(n=2, amount=usdc(10))
    organizer = accounts["organizer"]
    time_travel(DAY + 1)
    before = balance(token, organizer)

    dd.functions.refund([k.address for k in keys]).transact({"from": organizer})
    assert balance(token, organizer) == before + usdc(20)


def test_cannot_refund_claimed_drop(dd, accounts, create_campaign, sign, reverts):
    _, keys = create_campaign()
    alice, relayer = accounts["alice"], accounts["relayer"]
    dd.functions.claim(keys[0].address, alice, relayer, 0, sign(keys[0], alice, relayer, 0)).transact(
        {"from": relayer}
    )
    with reverts(dd, "DropNotActive"):
        dd.functions.refund([keys[0].address]).transact({"from": accounts["organizer"]})


def test_only_owner_can_refund(dd, accounts, create_campaign, reverts):
    _, keys = create_campaign()
    with reverts(dd, "NotCampaignOwner"):
        dd.functions.refund([keys[0].address]).transact({"from": accounts["mallory"]})


def test_refund_rejects_duplicate_keys_in_one_call(dd, accounts, create_campaign, reverts):
    """Listing a drop twice must not pay it out twice."""
    _, keys = create_campaign(n=1)
    with reverts(dd, "DropNotActive"):
        dd.functions.refund([keys[0].address, keys[0].address]).transact({"from": accounts["organizer"]})


# ------------------------------------------------------------------ campaign validation


def test_add_drops_to_existing_campaign(dd, token, accounts, create_campaign):
    campaign_id, _ = create_campaign(n=1, amount=usdc(10))
    organizer = accounts["organizer"]
    more = [claims.new_claim_key() for _ in range(2)]
    token.functions.approve(dd.address, usdc(20)).transact({"from": organizer})

    dd.functions.addDrops(campaign_id, [k.address for k in more]).transact({"from": organizer})

    assert balance(token, dd.address) == usdc(30)
    assert dd.functions.getDrop(more[1].address).call()[:2] == [campaign_id, ACTIVE]


def test_only_owner_can_add_drops(dd, token, accounts, create_campaign, reverts):
    campaign_id, _ = create_campaign()
    with reverts(dd, "NotCampaignOwner"):
        dd.functions.addDrops(campaign_id, [claims.new_claim_key().address]).transact({"from": accounts["mallory"]})


@pytest.mark.parametrize(
    "kwargs,error",
    [
        ({"amount": 0}, "InvalidAmount"),
        ({"amount": usdc("50.000001")}, "InvalidAmount"),
        ({"amount": usdc(1), "fee_cap": usdc("0.11")}, "InvalidFeeCap"),
        ({"amount": usdc("0.05"), "fee_cap": usdc("0.05")}, "InvalidFeeCap"),
        ({"expires_in": 0}, "InvalidExpiry"),
        ({"n": 0}, "InvalidDropCount"),
        ({"n": 201}, "InvalidDropCount"),
    ],
)
def test_create_campaign_validation(create_campaign, dd, kwargs, error, reverts):
    with reverts(dd, error):
        create_campaign(**kwargs)


def test_max_drop_amount_allowed(create_campaign, dd, token):
    create_campaign(n=1, amount=usdc(50))
    assert balance(token, dd.address) == usdc(50)


def test_duplicate_claim_key_rejected(dd, token, accounts, now, reverts):
    organizer = accounts["organizer"]
    key = claims.new_claim_key()
    token.functions.approve(dd.address, usdc(20)).transact({"from": organizer})

    with reverts(dd, "DropExists"):
        dd.functions.createCampaign(usdc(10), now() + DAY, 0, [key.address, key.address]).transact({"from": organizer})


def test_zero_claim_key_rejected(dd, token, accounts, now, reverts):
    organizer = accounts["organizer"]
    token.functions.approve(dd.address, usdc(10)).transact({"from": organizer})

    with reverts(dd, "InvalidClaimKey"):
        dd.functions.createCampaign(usdc(10), now() + DAY, 0, [ZERO_ADDRESS]).transact({"from": organizer})


def test_create_without_approval_fails(dd, token, accounts, now, reverts):
    with reverts(token, "ERC20InsufficientAllowance"):
        dd.functions.createCampaign(usdc(10), now() + DAY, 0, [claims.new_claim_key().address]).transact(
            {"from": accounts["organizer"]}
        )


# ------------------------------------------------------------------ accounting


def test_contract_balance_always_covers_active_drops(dd, token, accounts, create_campaign, sign):
    """After a mix of claims and refunds, what's left in the box equals the active drops exactly."""
    _, keys = create_campaign(n=5, amount=usdc(10))
    relayer, organizer = accounts["relayer"], accounts["organizer"]
    recipients = [accounts["alice"], accounts["bob"]]

    for key, who in zip(keys[:2], recipients):
        fee = usdc("0.03")
        dd.functions.claim(key.address, who, relayer, fee, sign(key, who, relayer, fee)).transact({"from": relayer})
    dd.functions.refund([keys[2].address]).transact({"from": organizer})

    active = [k for k in keys if dd.functions.getDrop(k.address).call()[1] == ACTIVE]
    assert len(active) == 2
    assert balance(token, dd.address) == usdc(10) * len(active)


def test_lost_links_can_be_recovered_from_events_and_refunded(w3, dd, token, accounts, create_campaign, sign):
    """An organizer who loses every link can rebuild the key list from DropCreated logs and refund."""
    campaign_id, keys = create_campaign(n=3, amount=usdc(10))
    organizer, relayer, alice = accounts["organizer"], accounts["relayer"], accounts["alice"]
    dd.functions.claim(keys[0].address, alice, relayer, 0, sign(keys[0], alice, relayer, 0)).transact(
        {"from": relayer}
    )

    logs = dd.events.DropCreated().get_logs(from_block=0, argument_filters={"campaignId": campaign_id})
    recovered = [log.args.claimKey for log in logs]
    assert recovered == [k.address for k in keys]

    unclaimed = [k for k in recovered if dd.functions.getDrop(k).call()[1] == ACTIVE]
    before = balance(token, organizer)
    dd.functions.refund(unclaimed).transact({"from": organizer})
    assert balance(token, organizer) == before + usdc(20)
