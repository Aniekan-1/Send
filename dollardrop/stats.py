"""Dashboard queries over the event index. All amounts are USDC in 6-decimal units."""

import time

from dollardrop.indexer import Index

DAY = 86_400

_CAMPAIGN_COUNTS = """
    SELECT c.*,
           COUNT(d.claim_key)                                   AS drops,
           SUM(d.status = 'claimed')                            AS claimed,
           SUM(d.status = 'refunded')                           AS refunded,
           SUM(d.status = 'active')                             AS active,
           COALESCE(SUM(CASE WHEN d.status = 'claimed' THEN d.received END), 0) AS distributed,
           MAX(d.claimed_at)                                    AS last_claim_at
    FROM campaigns c LEFT JOIN drops d ON d.campaign_id = c.id
"""


def _campaign(row: dict, now: int) -> dict:
    row = {k: (v if v is not None else 0) for k, v in row.items()}
    row["paused"] = bool(row["paused"])
    row["expired"] = row["expires_at"] <= now
    row["locked"] = row["active"] * row["amount"]  # still in the money box, claimable or refundable
    if row["last_claim_at"] == 0:
        row["last_claim_at"] = None
    return row


def totals(ix: Index) -> dict:
    row = ix.one("""
        SELECT (SELECT COUNT(*) FROM campaigns)                                  AS campaigns,
               COUNT(*)                                                          AS drops,
               COALESCE(SUM(status = 'claimed'), 0)                              AS claimed,
               COALESCE(SUM(status = 'refunded'), 0)                             AS refunded,
               COALESCE(SUM(status = 'active'), 0)                               AS active,
               COUNT(DISTINCT recipient)                                         AS recipients,
               COALESCE(SUM(received), 0)                                        AS distributed,
               COALESCE(SUM(fee), 0)                                             AS fees
        FROM drops
    """)
    locked = ix.one("""
        SELECT COALESCE(SUM(c.amount), 0) AS locked
        FROM drops d JOIN campaigns c ON c.id = d.campaign_id WHERE d.status = 'active'
    """)
    return {**row, "locked": locked["locked"]}


def public_totals(ix: Index) -> dict:
    """Safe for the landing page: aggregate counts only."""
    t = totals(ix)
    return {k: t[k] for k in ("campaigns", "claimed", "recipients", "distributed")}


def claims_by_day(ix: Index, days: int = 30, now: int | None = None) -> list[dict]:
    """One row per UTC day for the last `days` days, zero-filled, oldest first."""
    now = now or int(time.time())
    today = now // DAY
    first = today - days + 1
    rows = ix.rows(
        """SELECT claimed_at / 86400 AS day, COUNT(*) AS claims, SUM(received) AS amount
           FROM drops WHERE status = 'claimed' AND claimed_at >= ? GROUP BY day""",
        (first * DAY,),
    )
    by_day = {r["day"]: r for r in rows}
    out = []
    for d in range(first, today + 1):
        r = by_day.get(d, {})
        out.append({
            "date": time.strftime("%Y-%m-%d", time.gmtime(d * DAY)),
            "claims": r.get("claims", 0),
            "amount": r.get("amount", 0) or 0,
        })
    return out


def campaigns(ix: Index, owner: str | None = None, now: int | None = None) -> list[dict]:
    now = now or int(time.time())
    where, params = ("WHERE c.owner = ?", (owner,)) if owner else ("", ())
    rows = ix.rows(f"{_CAMPAIGN_COUNTS} {where} GROUP BY c.id ORDER BY c.id DESC", params)
    return [_campaign(r, now) for r in rows]


def campaign(ix: Index, campaign_id: int, now: int | None = None) -> dict | None:
    now = now or int(time.time())
    row = ix.one(f"{_CAMPAIGN_COUNTS} WHERE c.id = ? GROUP BY c.id", (campaign_id,))
    if row is None:
        return None
    detail = _campaign(row, now)
    detail["drops_list"] = ix.rows(
        """SELECT claim_key, status, recipient, received, fee, claimed_at, claim_tx, refunded_at
           FROM drops WHERE campaign_id = ? ORDER BY created_at, claim_key""",
        (campaign_id,),
    )
    return detail


def recent_claims(ix: Index, limit: int = 20) -> list[dict]:
    return ix.rows(
        """SELECT d.claim_key, d.campaign_id, d.recipient, d.received, d.fee, d.claimed_at, d.claim_tx
           FROM drops d WHERE d.status = 'claimed' ORDER BY d.claimed_at DESC LIMIT ?""",
        (limit,),
    )
