"""Index DollarDrop's on-chain events into SQLite, for the dashboards.

Everything here is public chain data; the index only makes it fast to query. It can always be
rebuilt from scratch by deleting the database file: `sync()` replays events from the deploy block.

    index = Index("data/index.sqlite")
    Indexer(w3, contract, index, from_block=deploy_block).sync()
"""

import logging
import sqlite3
import threading
from pathlib import Path

from web3 import Web3
from web3.contract import Contract

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY,
    owner TEXT NOT NULL,
    amount INTEGER NOT NULL,          -- per drop, USDC 6 decimals
    expires_at INTEGER NOT NULL,
    fee_cap INTEGER NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    created_tx TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS campaigns_owner ON campaigns (owner);
CREATE TABLE IF NOT EXISTS drops (
    claim_key TEXT PRIMARY KEY,
    campaign_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',   -- active | claimed | refunded
    created_at INTEGER NOT NULL,
    recipient TEXT,
    relayer TEXT,
    received INTEGER,                        -- what the recipient got (after fee)
    fee INTEGER,
    claimed_at INTEGER,
    claim_tx TEXT,
    refunded_at INTEGER
);
CREATE INDEX IF NOT EXISTS drops_campaign ON drops (campaign_id);
CREATE INDEX IF NOT EXISTS drops_claimed_at ON drops (claimed_at);
"""


class Index:
    """The SQLite side: writes from the indexer, reads for the API. Safe to share across threads."""

    def __init__(self, path: str | Path = ":memory:"):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(SCHEMA)

    def execute(self, sql: str, params: tuple = ()) -> None:
        with self._lock, self._db:
            self._db.execute(sql, params)

    def rows(self, sql: str, params: tuple = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._db.execute(sql, params).fetchall()]

    def one(self, sql: str, params: tuple = ()) -> dict | None:
        rows = self.rows(sql, params)
        return rows[0] if rows else None

    def get_meta(self, key: str) -> str | None:
        row = self.one("SELECT value FROM meta WHERE key = ?", (key,))
        return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                     (key, value))


EVENTS = ("CampaignCreated", "DropCreated", "Claimed", "Refunded", "PausedSet")


class Indexer:
    def __init__(self, w3: Web3, contract: Contract, index: Index, *, from_block: int = 0, chunk: int = 5_000):
        self.w3 = w3
        self.contract = contract
        self.index = index
        self.from_block = from_block
        self.chunk = chunk
        self._block_times: dict[int, int] = {}

    @property
    def last_block(self) -> int:
        value = self.index.get_meta("last_block")
        return int(value) if value is not None else self.from_block - 1

    def sync(self) -> int:
        """Index everything up to the latest block. Returns the number of events applied."""
        head = self.w3.eth.block_number
        applied = 0
        start = self.last_block + 1
        while start <= head:
            end = min(start + self.chunk - 1, head)
            logs = self.w3.eth.get_logs({"address": self.contract.address, "fromBlock": start, "toBlock": end})
            for raw in sorted(logs, key=lambda l: (l["blockNumber"], l["logIndex"])):
                applied += self._apply(raw)
            self.index.set_meta("last_block", str(end))
            start = end + 1
        return applied

    def run_forever(self, interval: float = 5, stop: threading.Event | None = None) -> None:
        stop = stop or threading.Event()
        while not stop.is_set():
            try:
                n = self.sync()
                if n:
                    log.info("indexed %d events up to block %d", n, self.last_block)
            except Exception:
                log.exception("indexer sync failed; retrying")
            stop.wait(interval)

    def start_background(self, interval: float = 5) -> threading.Event:
        stop = threading.Event()
        threading.Thread(target=self.run_forever, args=(interval, stop), daemon=True, name="indexer").start()
        return stop

    # ------------------------------------------------------------ events

    def _decode(self, raw):
        for name in EVENTS:
            try:
                return name, self.contract.events[name]().process_log(raw)
            except Exception:
                continue
        return None, None

    def _time(self, block_number: int) -> int:
        if block_number not in self._block_times:
            self._block_times[block_number] = self.w3.eth.get_block(block_number)["timestamp"]
        return self._block_times[block_number]

    def _apply(self, raw) -> int:
        name, event = self._decode(raw)
        if event is None:
            return 0
        a = event.args
        at = self._time(raw["blockNumber"])
        tx = "0x" + bytes(raw["transactionHash"]).hex()
        ix = self.index

        if name == "CampaignCreated":
            ix.execute(
                "INSERT OR IGNORE INTO campaigns (id, owner, amount, expires_at, fee_cap, created_at, created_tx) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (a.campaignId, a.owner, a.amountPerDrop, a.expiresAt, a.feeCap, at, tx),
            )
        elif name == "DropCreated":
            ix.execute("INSERT OR IGNORE INTO drops (claim_key, campaign_id, created_at) VALUES (?, ?, ?)",
                       (a.claimKey, a.campaignId, at))
        elif name == "Claimed":
            ix.execute(
                "UPDATE drops SET status='claimed', recipient=?, relayer=?, received=?, fee=?, claimed_at=?, claim_tx=? "
                "WHERE claim_key=?",
                (a.recipient, a.relayer, a.amount, a.fee, at, tx, a.claimKey),
            )
        elif name == "Refunded":
            ix.execute("UPDATE drops SET status='refunded', refunded_at=? WHERE claim_key=?", (at, a.claimKey))
        elif name == "PausedSet":
            ix.execute("UPDATE campaigns SET paused=? WHERE id=?", (int(a.paused), a.campaignId))
        return 1
