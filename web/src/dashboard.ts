// Dashboard: organizers see their own campaigns; the operator (admin token) sees everything.
//
// Data comes from the relayer's event index (fast, public chain data). Pause and refund are sent
// from the organizer's own wallet, straight to the contract; the dashboard never holds keys.
import { type Address, getAddress, isAddress } from "viem";
import { type Campaign, type DropRow, type Overview, dashboardApi } from "./api";
import { columnChart, chartTable } from "./charts";
import { fundingEntry, unlockFunding } from "./backup";
import { type Connection, connectWallet, connectWithKey, ensureArc, sendUsdc, usdcBalance } from "./connect";
import { publicClient, requireContract, txLink } from "./config";
import { ago, count, dateTime, plural, shortAddress, shortDay, usd, usdCompact } from "./format";
import { dollarDropAbi } from "./generated/abi";
import { renderNav } from "./nav";
import { parseUnits } from "viem";
import { $, errorMessage, html, raw } from "./ui";

renderNav();

const TOKEN = "dd:admin-token";
const VIEWER = "dd:dashboard-address";
const REFRESH_MS = 15_000;
const MAX_PER_CALL = 200;

const views = {
  organizer: $("#view-organizer"),
  operator: $("#view-operator"),
  campaign: $("#view-campaign"),
};
let connection: Connection | null = null;
let viewing: Address | null = null; // whose campaigns the organizer tab shows
let timer: number | undefined;
let current: () => Promise<void> = async () => {};

// ------------------------------------------------------------------ shared bits

function statusBadge(c: Campaign): string {
  if (c.active === 0) return `<span class="badge plain">Finished</span>`;
  if (c.paused) return `<span class="badge warn">Paused</span>`;
  if (c.expired) return `<span class="badge bad">Expired</span>`;
  return `<span class="badge good">Open</span>`;
}

function dropBadge(d: DropRow): string {
  return { claimed: `<span class="badge good">Claimed</span>`, refunded: `<span class="badge plain">Refunded</span>`, active: `<span class="badge">Waiting</span>` }[d.status];
}

function progress(c: Campaign): string {
  const pct = (n: number) => (c.drops ? (n / c.drops) * 100 : 0);
  return `<div class="progress" role="img" aria-label="${c.claimed} of ${c.drops} claimed, ${c.refunded} refunded">
    <span class="p-claimed" style="width:${pct(c.claimed)}%"></span><span class="p-refunded" style="width:${pct(c.refunded)}%"></span></div>`;
}

function txAnchor(hash: string | null, label = "View"): string {
  if (!hash) return "";
  const link = txLink(hash);
  return link ? html`<a href="${link}" target="_blank" rel="noopener">${label}</a>` : html`<code title="${hash}">${hash.slice(0, 10)}…</code>`;
}

function setFreshness(indexedBlock: number) {
  $("#freshness").textContent = `Live from Arc · indexed to block ${indexedBlock.toLocaleString()} · updated ${new Date().toLocaleTimeString()}`;
}

function loading(host: HTMLElement) {
  host.innerHTML = `<div class="grid grid-4">${'<div class="card"><div class="skeleton" style="height:56px"></div></div>'.repeat(4)}</div>
    <div class="card"><div class="skeleton" style="height:160px"></div></div>`;
}

function problem(host: HTMLElement, e: unknown) {
  host.innerHTML = html`<div class="alert bad">${errorMessage(e)}</div>`;
}

function schedule(fn: () => Promise<void>) {
  current = fn;
  window.clearInterval(timer);
  timer = window.setInterval(() => document.visibilityState === "visible" && current().catch(console.error), REFRESH_MS);
}

function campaignCard(c: Campaign): string {
  return html`<article class="card stack clickable-card" data-campaign="${c.id}" tabindex="0" role="button" aria-label="Open campaign ${c.id}">
    <div class="row between"><h3>Campaign #${c.id}</h3>${raw(statusBadge(c))}</div>
    <div class="row between small">
      <span><strong>${count(c.claimed)}</strong> of ${count(c.drops)} claimed</span>
      <span class="muted">${usd(c.amount)} each</span>
    </div>
    ${raw(progress(c))}
    <div class="row between tiny muted">
      <span>${c.last_claim_at ? `Last claim ${ago(c.last_claim_at)}` : "No claims yet"}</span>
      <span>${c.locked ? `${usd(c.locked)} unclaimed` : `${usd(c.distributed)} sent`}</span>
    </div>
  </article>`;
}

function wireCampaignLinks(host: HTMLElement) {
  host.querySelectorAll<HTMLElement>("[data-campaign]").forEach((el) => {
    const open = () => openCampaign(Number(el.dataset.campaign));
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open()));
  });
}

// ------------------------------------------------------------------ organizer tab

async function renderOrganizer() {
  const host = views.organizer;
  if (!viewing) {
    host.innerHTML = html`
      <div class="card stack" style="max-width:560px">
        <h2>Your campaigns</h2>
        <p class="muted">Connect the wallet you created drops with to see their progress, pause them, or refund unclaimed money.</p>
        <button class="btn primary" data-act="connect">Connect wallet</button>
        <label class="btn" style="display:flex">Open with my backup file
          <input type="file" id="backup-file" accept=".csv,text/csv" hidden /></label>
        <p class="muted small">Funded your drops from an exchange? Choose the backup file you downloaded when you created them; look in your Downloads folder for a file starting with <code>dollar-drop-</code>. It's read only in this browser, never uploaded, and lets you refund unclaimed drops and send money back to your exchange.</p>
        <form class="row tight" id="backup-unlock" hidden>
          <input id="backup-unlock-password" type="password" autocomplete="current-password" placeholder="Backup password" required />
          <button class="btn primary" type="submit">Unlock</button>
        </form>
        <div class="divider"><span>or look up any organizer (read only)</span></div>
        <form class="row tight" id="lookup">
          <input id="lookup-address" placeholder="0x… wallet address" autocomplete="off" spellcheck="false" />
          <button class="btn" type="submit">View</button>
        </form>
        <p class="error small" id="org-error" hidden></p>
      </div>`;
    $("[data-act=connect]", host).addEventListener("click", async () => {
      try {
        connection = await connectWallet();
        viewing = connection.account;
        await renderOrganizer();
      } catch (e) {
        const err = $("#org-error", host);
        err.textContent = errorMessage(e);
        err.hidden = false;
      }
    });
    const showError = (message: string) => {
      const err = $("#org-error", host);
      err.textContent = message;
      err.hidden = false;
    };
    const open = async (key: `0x${string}`) => {
      connection = connectWithKey(key);
      viewing = connection.account;
      await renderOrganizer();
    };
    $<HTMLInputElement>("#backup-file", host).addEventListener("change", async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const entry = fundingEntry(await file.text());
      if (!entry) {
        return showError("That file has no funding wallet. It's only in backups of campaigns funded from an exchange; for the others, connect the wallet you used.");
      }
      $("#org-error", host).hidden = true;
      if (!entry.encrypted) return open(await unlockFunding(entry)); // older, unprotected backups
      const form = $("#backup-unlock", host);
      form.hidden = false;
      $<HTMLInputElement>("#backup-unlock-password", host).focus();
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        try {
          await open(await unlockFunding(entry, $<HTMLInputElement>("#backup-unlock-password", host).value));
        } catch (err) {
          showError(errorMessage(err));
        }
      };
    });
    $("#lookup", host).addEventListener("submit", (e) => {
      e.preventDefault();
      const value = $<HTMLInputElement>("#lookup-address", host).value.trim();
      if (!isAddress(value)) {
        const err = $("#org-error", host);
        err.textContent = "That doesn't look like a wallet address.";
        err.hidden = false;
        return;
      }
      viewing = getAddress(value);
      sessionStorage.setItem(VIEWER, viewing);
      renderOrganizer();
    });
    return;
  }

  loading(host);
  const load = async () => {
    const { campaigns, indexedBlock } = await dashboardApi.organizerCampaigns(viewing!);
    setFreshness(indexedBlock);
    const totals = campaigns.reduce(
      (t, c) => ({ sent: t.sent + c.distributed, claimed: t.claimed + c.claimed, drops: t.drops + c.drops, locked: t.locked + c.locked }),
      { sent: 0, claimed: 0, drops: 0, locked: 0 },
    );
    const mine = connection?.account === viewing;
    const fundingBalance = connection?.local && mine ? await usdcBalance(connection.account) : null;
    host.innerHTML = html`
      <div class="row between">
        <p class="muted small">${mine ? (connection?.local ? "Funding wallet" : "Connected as") : "Viewing"} <code>${shortAddress(viewing!)}</code></p>
        <div class="row">
          <a class="btn primary small" href="/organize.html">New campaign</a>
          <button class="btn ghost small" data-act="switch">${mine ? "Disconnect" : "Change"}</button>
        </div>
      </div>
      ${raw(fundingBalance === null ? "" : fundingCard(fundingBalance))}
      <div class="grid grid-4">
        <div class="card tile"><span class="label">Sent to recipients</span><span class="value">${usdCompact(totals.sent)}</span></div>
        <div class="card tile"><span class="label">Drops claimed</span><span class="value">${count(totals.claimed)}<span class="muted small"> / ${count(totals.drops)}</span></span></div>
        <div class="card tile"><span class="label">Waiting to be claimed</span><span class="value">${usdCompact(totals.locked)}</span></div>
        <div class="card tile"><span class="label">Campaigns</span><span class="value">${campaigns.length}</span></div>
      </div>
      ${raw(campaigns.length
        ? `<div class="grid grid-3">${campaigns.map(campaignCard).join("")}</div>`
        : html`<div class="card empty"><h3>No campaigns yet</h3><p>Campaigns you fund will show up here within a few seconds.</p>
            <p class="mt"><a class="btn primary" href="/organize.html">Create your first drops</a></p></div>`)}`;
    $("[data-act=switch]", host).addEventListener("click", () => {
      connection = null;
      viewing = null;
      sessionStorage.removeItem(VIEWER);
      renderOrganizer();
    });
    wireCampaignLinks(host);
    if (fundingBalance !== null) wireFundingCard(host, fundingBalance, load);
  };
  try {
    await load();
    schedule(load);
  } catch (e) {
    problem(host, e);
  }
}

const FEE_RESERVE = parseUnits("0.01", 6); // left behind so the transfer can pay its own network fee

function fundingCard(balance: bigint): string {
  return html`<div class="card stack">
    <div class="row between"><h2>Funding wallet</h2><span class="value" style="font-size:1.5rem;font-weight:700">${usd(balance)}</span></div>
    <p class="muted small">Refunds and unused fee money land here. Send it back to your exchange: use your exchange's USDC deposit address on the <strong>Arc</strong> network.</p>
    <form class="grid-form" id="withdraw-form">
      <label>To (exchange deposit address)<input id="withdraw-to" placeholder="0x…" autocomplete="off" spellcheck="false" required /></label>
      <label>Amount (USD)<div class="row tight"><input id="withdraw-amount" inputmode="decimal" required /><button class="btn small" type="button" data-act="max">Max</button></div></label>
      <button class="btn primary span" type="submit" ${balance > FEE_RESERVE ? "" : "disabled"}>Send</button>
      <p class="small span" id="withdraw-status" aria-live="polite"></p>
    </form>
  </div>`;
}

function wireFundingCard(host: HTMLElement, balance: bigint, reload: () => Promise<void>) {
  const status = $("#withdraw-status", host);
  $("[data-act=max]", host).addEventListener("click", () => {
    $<HTMLInputElement>("#withdraw-amount", host).value = balance > FEE_RESERVE ? (Number(balance - FEE_RESERVE) / 1e6).toFixed(6).replace(/\.?0+$/, "") : "0";
  });
  $("#withdraw-form", host).addEventListener("submit", async (e) => {
    e.preventDefault();
    const to = $<HTMLInputElement>("#withdraw-to", host).value.trim();
    const text = $<HTMLInputElement>("#withdraw-amount", host).value.trim().replace(/^\$/, "");
    status.className = "small span error";
    if (!isAddress(to)) return void (status.textContent = "That doesn't look like an Arc address (it starts with 0x).");
    if (!/^\d+(\.\d{1,6})?$/.test(text)) return void (status.textContent = "Enter an amount like 5 or 5.25.");
    const amount = parseUnits(text, 6);
    if (amount <= 0n || amount + FEE_RESERVE > balance) return void (status.textContent = `You can send up to ${usd(balance > FEE_RESERVE ? balance - FEE_RESERVE : 0n)}.`);
    if (!confirm(`Send ${usd(amount)} to ${to}?

Make sure it's a USDC deposit address on the Arc network. Payments can't be reversed.`)) return;
    status.className = "small span muted";
    status.textContent = "Sending…";
    try {
      await sendUsdc(connection!, getAddress(to), amount);
      await reload();
      $("#withdraw-status", host).className = "small span ok";
      $("#withdraw-status", host).textContent = `Sent ${usd(amount)}.`;
    } catch (err) {
      status.className = "small span error";
      status.textContent = errorMessage(err);
    }
  });
}

// ------------------------------------------------------------------ operator tab

async function renderOperator() {
  const host = views.operator;
  const token = sessionStorage.getItem(TOKEN);
  if (!token) {
    host.innerHTML = html`
      <form class="card stack" id="admin-form" style="max-width:480px">
        <h2>Operator sign-in</h2>
        <p class="muted small">Enter the <code>ADMIN_TOKEN</code> from the server's <code>.env</code>. It's kept in this tab only.</p>
        <input id="admin-token" type="password" autocomplete="current-password" required placeholder="Admin token" />
        <button class="btn primary" type="submit">Open operator view</button>
      </form>`;
    $("#admin-form", host).addEventListener("submit", (e) => {
      e.preventDefault();
      sessionStorage.setItem(TOKEN, $<HTMLInputElement>("#admin-token", host).value.trim());
      renderOperator();
    });
    return;
  }

  loading(host);
  const load = async () => {
    let o: Overview;
    try {
      o = await dashboardApi.adminOverview(token);
    } catch (e) {
      if ((e as { status?: number }).status === 401) {
        sessionStorage.removeItem(TOKEN);
        await renderOperator();
        $("#view-operator .card")?.insertAdjacentHTML("afterbegin", `<div class="alert bad">That token wasn't accepted.</div>`);
        return;
      }
      throw e;
    }
    setFreshness(o.indexedBlock);
    drawOperator(host, o);
  };
  try {
    await load();
    schedule(load);
  } catch (e) {
    problem(host, e);
  }
}

function drawOperator(host: HTMLElement, o: Overview) {
  const t = o.totals;
  const claimRate = t.claimed + t.active ? Math.round((t.claimed / (t.claimed + t.active)) * 100) : 0;
  const points = o.claimsByDay.map((d) => ({
    label: shortDay(d.date),
    value: d.claims,
    tooltip: `${d.claims} claim${d.claims === 1 ? "" : "s"}`,
    detail: usd(d.amount),
  }));
  const last30 = o.claimsByDay.reduce((s, d) => s + d.claims, 0);
  const r = o.relayer;

  host.innerHTML = html`
    <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(300px, 1fr))">
      <div class="card stack">
        <span class="eyebrow">Sent to recipients</span>
        <span class="hero-figure">${usd(t.distributed)}</span>
        <span class="muted small">${plural(t.recipients, "person", "people")} · ${plural(t.claimed, "drop")} claimed · ${plural(t.campaigns, "campaign")}</span>
      </div>
      <div class="card stack">
        <div class="row between"><span class="eyebrow">Helper wallet</span>
          ${raw(r.lowBalance ? `<span class="badge bad">Low balance</span>` : `<span class="badge good">Healthy</span>`)}</div>
        <span class="value" style="font-size:1.7rem;font-weight:700">${usd(Math.floor(r.balanceUsdc * 1e6))}</span>
        <span class="muted small">≈ ${count(Math.floor((r.balanceUsdc * 1e6) / Math.max(r.claimCost, 1)))} claims of gas left · <code>${shortAddress(r.address)}</code></span>
      </div>
    </div>
    <div class="grid grid-4">
      <div class="card tile"><span class="label">Waiting to be claimed</span><span class="value">${usdCompact(t.locked)}</span><span class="sub">${plural(t.active, "drop")}</span></div>
      <div class="card tile"><span class="label">Claim rate</span><span class="value">${claimRate}%</span><span class="sub">claimed of not-refunded</span></div>
      <div class="card tile"><span class="label">Fees earned</span><span class="value">${usd(t.fees)}</span><span class="sub">repaid to the helper wallet</span></div>
      <div class="card tile"><span class="label">Refunded</span><span class="value">${count(t.refunded)}</span><span class="sub">drops returned to organizers</span></div>
    </div>
    <div class="card stack">
      <div class="section-title"><h2>Claims per day</h2><span class="muted small">${count(last30)} in the last 30 days (UTC)</span></div>
      <div id="claims-chart"></div>
      <details><summary class="small muted">Show as table</summary>${raw(chartTable(points, ["Day", "Claims", "Sent"]))}</details>
    </div>
    <div class="grid grid-2">
      <div class="card flush">
        <div class="card-head"><h2>Campaigns</h2><span class="muted small">${o.campaigns.length}</span></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>#</th><th>Organizer</th><th class="r">Claimed</th><th class="r">Unclaimed</th><th>Status</th></tr></thead>
          <tbody>${raw(o.campaigns.map((c) => html`<tr class="clickable" data-campaign="${c.id}" tabindex="0">
            <td>${c.id}</td><td><code>${shortAddress(c.owner)}</code></td>
            <td class="r">${c.claimed}/${c.drops}</td><td class="r">${usd(c.locked)}</td><td>${raw(statusBadge(c))}</td></tr>`).join("")
            || `<tr><td colspan="5" class="muted">No campaigns yet</td></tr>`)}</tbody>
        </table></div>
      </div>
      <div class="card flush">
        <div class="card-head"><h2>Recent claims</h2></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>When</th><th>Recipient</th><th class="r">Amount</th><th>Tx</th></tr></thead>
          <tbody>${raw(o.recentClaims.map((d) => html`<tr>
            <td>${ago(d.claimed_at!)}</td><td><code>${shortAddress(d.recipient!)}</code></td>
            <td class="r">${usd(d.received ?? 0)}</td><td>${raw(txAnchor(d.claim_tx))}</td></tr>`).join("")
            || `<tr><td colspan="4" class="muted">No claims yet</td></tr>`)}</tbody>
        </table></div>
      </div>
    </div>
    <div class="row between">
      <span class="muted tiny">Contract <code>${o.contract}</code> · chain ${o.chainId}</span>
      <button class="btn ghost small" data-act="signout">Sign out of operator view</button>
    </div>`;

  columnChart($("#claims-chart", host), points, {
    ariaLabel: `Claims per day for the last 30 days; ${last30} in total`,
    tickFormat: (v) => (Number.isInteger(v) ? String(v) : ""),
  });
  wireCampaignLinks(host);
  $("[data-act=signout]", host).addEventListener("click", () => {
    sessionStorage.removeItem(TOKEN);
    window.clearInterval(timer);
    renderOperator();
  });
}

// ------------------------------------------------------------------ campaign detail

let returnTo: "organizer" | "operator" = "organizer";

async function openCampaign(id: number) {
  returnTo = views.operator.hidden ? "organizer" : "operator";
  show("campaign");
  history.replaceState(null, "", `#campaign-${id}`);
  const host = views.campaign;
  loading(host);
  const load = async () => {
    const c = await dashboardApi.campaign(id);
    setFreshness(c.indexedBlock);
    const isOwner = connection?.account?.toLowerCase() === c.owner.toLowerCase();
    const unclaimed = c.drops_list.filter((d) => d.status === "active").map((d) => d.claim_key);

    host.innerHTML = html`
      <div class="row between">
        <button class="btn ghost small" data-act="back">← Back</button>
        ${raw(statusBadge(c))}
      </div>
      <div class="card stack">
        <div class="row between">
          <div class="stack" style="gap:4px"><h2>Campaign #${c.id}</h2>
            <span class="muted small">By <code>${shortAddress(c.owner)}</code> · created ${ago(c.created_at)} · claim by ${dateTime(c.expires_at)}</span></div>
          <div class="row">${raw(isOwner ? actionButtons(c, unclaimed.length) : connection ? "" : `<button class="btn small" data-act="connect">Connect to manage</button>`)}</div>
        </div>
        ${raw(progress(c))}
        <div class="grid grid-4">
          <div class="tile"><span class="label">Per drop</span><span class="value">${usd(c.amount)}</span></div>
          <div class="tile"><span class="label">Claimed</span><span class="value">${c.claimed}<span class="muted small"> / ${c.drops}</span></span></div>
          <div class="tile"><span class="label">Sent</span><span class="value">${usd(c.distributed)}</span></div>
          <div class="tile"><span class="label">Unclaimed</span><span class="value">${usd(c.locked)}</span></div>
        </div>
        <p class="error small" id="action-error" hidden></p>
        <p class="ok small" id="action-ok" hidden></p>
      </div>
      <div class="card flush">
        <div class="card-head"><h2>Drops</h2><span class="muted small">${c.drops_list.length}</span></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Drop</th><th>Status</th><th>Recipient</th><th class="r">Received</th><th>When</th><th>Tx</th></tr></thead>
          <tbody>${raw(c.drops_list.map((d, i) => html`<tr>
            <td>#${i + 1} <span class="muted tiny"><code>${shortAddress(d.claim_key)}</code></span></td>
            <td>${raw(dropBadge(d))}</td>
            <td>${d.recipient ? raw(html`<code>${shortAddress(d.recipient)}</code>`) : "—"}</td>
            <td class="r">${d.received != null ? usd(d.received) : "—"}</td>
            <td>${d.claimed_at ? ago(d.claimed_at) : d.refunded_at ? ago(d.refunded_at) : "—"}</td>
            <td>${raw(txAnchor(d.claim_tx))}</td></tr>`).join(""))}</tbody>
        </table></div>
      </div>`;

    $("[data-act=back]", host).addEventListener("click", () => {
      history.replaceState(null, "", location.pathname);
      selectTab(returnTo);
    });
    host.querySelector("[data-act=connect]")?.addEventListener("click", () =>
      connectWallet().then((c2) => ((connection = c2), load())).catch((e) => alert(errorMessage(e))),
    );
    host.querySelector("[data-act=pause]")?.addEventListener("click", () => act(() => setPaused(c.id, !c.paused), "Saved. It may take a few seconds to show here."));
    host.querySelector("[data-act=refund]")?.addEventListener("click", () => {
      if (!confirm(`Refund ${unclaimed.length} unclaimed drop(s), ${usd(c.locked)} in total? Their links will stop working.`)) return;
      act(() => refund(unclaimed), "Refunded. The money is back in your wallet.");
    });
  };

  const act = async (fn: () => Promise<void>, done: string) => {
    const err = $("#action-error", host);
    const ok = $("#action-ok", host);
    err.hidden = ok.hidden = true;
    host.querySelectorAll<HTMLButtonElement>("[data-act=pause],[data-act=refund]").forEach((b) => (b.disabled = true));
    try {
      await fn();
      await new Promise((r) => setTimeout(r, 6000)); // let the indexer catch up (it polls every 5 s)
      await load();
      $("#action-ok", host).textContent = done;
      $("#action-ok", host).hidden = false;
    } catch (e) {
      err.textContent = errorMessage(e);
      err.hidden = false;
      host.querySelectorAll<HTMLButtonElement>("[data-act=pause],[data-act=refund]").forEach((b) => (b.disabled = false));
    }
  };

  try {
    await load();
    schedule(load);
  } catch (e) {
    problem(host, e);
  }
}

function actionButtons(c: Campaign, unclaimed: number): string {
  const pause = c.active ? `<button class="btn small" data-act="pause">${c.paused ? "Resume claims" : "Pause claims"}</button>` : "";
  const refund = unclaimed ? `<button class="btn danger small" data-act="refund">Refund ${unclaimed} unclaimed</button>` : "";
  return pause + refund;
}

async function send(functionName: "setPaused" | "refund", args: readonly unknown[]) {
  if (!connection) throw new Error("Connect your wallet first.");
  await ensureArc(connection.wallet);
  const { request } = await publicClient.simulateContract({
    account: connection.signer, address: requireContract(), abi: dollarDropAbi,
    functionName, args: args as never,
  });
  const hash = await connection.wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The transaction failed.");
}

const setPaused = (id: number, paused: boolean) => send("setPaused", [BigInt(id), paused]);

async function refund(keys: Address[]) {
  for (let i = 0; i < keys.length; i += MAX_PER_CALL) await send("refund", [keys.slice(i, i + MAX_PER_CALL)]);
}

// ------------------------------------------------------------------ tabs

function show(view: keyof typeof views) {
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
}

function selectTab(tab: "organizer" | "operator") {
  $("#tab-organizer").setAttribute("aria-selected", String(tab === "organizer"));
  $("#tab-operator").setAttribute("aria-selected", String(tab === "operator"));
  show(tab);
  (tab === "organizer" ? renderOrganizer : renderOperator)();
}

$("#tab-organizer").addEventListener("click", () => selectTab("organizer"));
$("#tab-operator").addEventListener("click", () => selectTab("operator"));

const saved = sessionStorage.getItem(VIEWER);
if (saved && isAddress(saved)) viewing = getAddress(saved);
const deepLink = location.hash.match(/^#campaign-(\d+)$/);
if (deepLink) openCampaign(Number(deepLink[1]));
else selectTab(location.hash === "#operator" ? "operator" : "organizer");
