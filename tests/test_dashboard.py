"""Event indexer + dashboard API, against real contract events on the test chain."""

import pytest
from eth_account import Account
from fastapi.testclient import TestClient

from dollardrop.arc import usdc
from dollardrop.indexer import Index, Indexer
from dollardrop.relayer.app import create_app
from dollardrop.relayer.core import Relayer
from dollardrop import stats

ADMIN = "s3cret-admin-token"


@pytest.fixture
def relayer(w3, dd, accounts):
    acct = Account.create()
    w3.eth.send_transaction({"from": accounts["organizer"], "to": acct.address, "value": 10**21})
    return Relayer(w3, dd, acct)


@pytest.fixture
def indexer(w3, dd):
    return Indexer(w3, dd, Index(), chunk=3)  # tiny chunks exercise the paging


@pytest.fixture
def client(relayer, indexer):
    return TestClient(create_app(relayer, indexer=indexer, admin_token=ADMIN))


@pytest.fixture
def activity(dd, accounts, create_campaign, sign):
    """Campaign 1: 3 x $10, two claimed (fees 0.01/0.02), one refunded. Campaign 2: 2 x $5, paused."""
    relayer, organizer = accounts["relayer"], accounts["organizer"]
    _, keys = create_campaign(n=3, amount=usdc(10))
    for key, who, fee in ((keys[0], accounts["alice"], usdc("0.01")), (keys[1], accounts["bob"], usdc("0.02"))):
        dd.functions.claim(key.address, who, relayer, fee, sign(key, who, relayer, fee)).transact({"from": relayer})
    dd.functions.refund([keys[2].address]).transact({"from": organizer})

    c2, keys2 = create_campaign(n=2, amount=usdc(5))
    dd.functions.setPaused(c2, True).transact({"from": organizer})
    return keys, keys2


def test_sync_indexes_every_event(indexer, activity):
    keys, keys2 = activity
    # campaign 1: created + 3 drops + 2 claims + 1 refund; campaign 2: created + 2 drops + 1 pause
    assert indexer.sync() == (1 + 3 + 2 + 1) + (1 + 2 + 1)
    ix = indexer.index

    assert ix.one("SELECT status FROM drops WHERE claim_key = ?", (keys[0].address,))["status"] == "claimed"
    assert ix.one("SELECT status FROM drops WHERE claim_key = ?", (keys[2].address,))["status"] == "refunded"
    assert ix.one("SELECT paused FROM campaigns WHERE id = 2")["paused"] == 1
    assert indexer.sync() == 0  # nothing new: cursor advanced


def test_sync_is_incremental(indexer, dd, accounts, create_campaign, sign):
    _, keys = create_campaign(n=1)
    indexer.sync()
    assert stats.totals(indexer.index)["claimed"] == 0

    alice, relayer = accounts["alice"], accounts["relayer"]
    dd.functions.claim(keys[0].address, alice, relayer, 0, sign(keys[0], alice, relayer, 0)).transact({"from": relayer})
    assert indexer.sync() == 1
    assert stats.totals(indexer.index)["claimed"] == 1


def test_totals(indexer, activity):
    indexer.sync()
    t = stats.totals(indexer.index)
    assert t["campaigns"] == 2
    assert (t["drops"], t["claimed"], t["refunded"], t["active"]) == (5, 2, 1, 2)
    assert t["recipients"] == 2
    assert t["distributed"] == usdc(20) - usdc("0.03")
    assert t["fees"] == usdc("0.03")
    assert t["locked"] == usdc(10)  # campaign 2's two $5 drops


def test_claims_by_day_is_zero_filled(indexer, activity):
    indexer.sync()
    series = stats.claims_by_day(indexer.index, days=7)
    assert len(series) == 7
    assert sum(d["claims"] for d in series) == 2
    assert series[-1]["claims"] == 2  # all claims happened "today"


# ------------------------------------------------------------------ API


def test_public_stats(client, indexer, activity):
    indexer.sync()
    body = client.get("/stats/public").json()
    assert body["claimed"] == 2 and body["recipients"] == 2 and body["campaigns"] == 2
    assert "fees" not in body and "locked" not in body  # aggregate counts only


def test_organizer_sees_their_campaigns(client, indexer, accounts, activity):
    indexer.sync()
    body = client.get(f"/organizers/{accounts['organizer']}/campaigns").json()
    c1, c2 = sorted(body["campaigns"], key=lambda c: c["id"])
    assert (c1["drops"], c1["claimed"], c1["refunded"], c1["active"]) == (3, 2, 1, 0)
    assert c2["paused"] is True and c2["locked"] == usdc(10)

    stranger = client.get(f"/organizers/{accounts['mallory']}/campaigns").json()
    assert stranger["campaigns"] == []


def test_campaign_detail_lists_drops(client, indexer, accounts, activity):
    indexer.sync()
    body = client.get("/campaigns/1").json()
    statuses = sorted(d["status"] for d in body["drops_list"])
    assert statuses == ["claimed", "claimed", "refunded"]
    recipients = {d["recipient"] for d in body["drops_list"] if d["status"] == "claimed"}
    assert recipients == {accounts["alice"], accounts["bob"]}
    assert client.get("/campaigns/99").status_code == 404


def test_admin_overview_requires_token(client, indexer, activity):
    indexer.sync()
    assert client.get("/admin/overview").status_code == 401
    assert client.get("/admin/overview", headers={"Authorization": "Bearer wrong"}).status_code == 401

    body = client.get("/admin/overview", headers={"Authorization": f"Bearer {ADMIN}"}).json()
    assert body["totals"]["claimed"] == 2
    assert len(body["claimsByDay"]) == 30
    assert len(body["recentClaims"]) == 2
    assert body["relayer"]["lowBalance"] is False


def test_admin_disabled_without_configured_token(relayer, indexer):
    client = TestClient(create_app(relayer, indexer=indexer, admin_token=None))
    assert client.get("/admin/overview", headers={"Authorization": "Bearer "}).status_code == 401


def test_dashboard_routes_absent_without_indexer(relayer):
    client = TestClient(create_app(relayer))
    assert client.get("/stats/public").status_code == 404
