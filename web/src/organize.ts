// Organizer page: create, fund and print drops. Tracking, pausing and refunds live in the dashboard.
//
// Claim keys are generated here, in the organizer's browser. Only their addresses go on-chain.
// The organizer must download the backup before funding: without the links, drops can't be
// claimed (though they can still be found via DropCreated events and refunded).
//
// Two ways to pay:
// - Browser wallet (MetaMask, …): approve + createCampaign, signed in the wallet.
// - From an exchange: we make a one-time funding wallet here and show its address. The organizer
//   withdraws USDC to it from their exchange; once it lands, this page funds the drops itself,
//   paying gas from that same USDC. Only on Arc can a wallet holding nothing but USDC do that.
//   Its key goes in the backup file; the dashboard uses it later to refund and withdraw.
import { type Hex, erc20Abi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import QRCode from "qrcode";
import { backupCsv, downloadText } from "./backup";
import { USDC, arc, publicClient, requireContract } from "./config";
import { type Connection, connectWallet, connectWithKey, ensureArc, usdcBalance } from "./connect";
import { usd, parseUsd } from "./format";
import { dollarDropAbi } from "./generated/abi";
import { claimLink, newClaimSecret } from "./links";
import { renderNav } from "./nav";
import { $, errorMessage, html } from "./ui";

renderNav();

const MAX_DROP = 50_000_000n;
const MAX_FEE_CAP = 100_000n;
const MAX_PER_CALL = 200;
const PENDING = "dd:pending-exchange-campaign";
const POLL_MS = 4000;

type Mode = "wallet" | "exchange";

interface Plan {
  amount: bigint;
  count: number;
  expiresAt: bigint;
  feeCap: bigint;
  secrets: Hex[];
  links: string[];
  fundingKey?: Hex; // exchange mode only
  funded?: boolean;
}

let mode: Mode = "wallet";
let connection: Connection | undefined;
let plan: Plan | undefined;
let poll: number | undefined;

const siteUrl = () => location.origin + location.pathname.replace(/[^/]*$/, "");
const total = (p: Plan) => p.amount * BigInt(p.count);

// ------------------------------------------------------------------ choose how to pay

async function connect() {
  connection = await connectWallet();
  mode = "wallet";
  const balance = await usdcBalance(connection.account);
  $("#wallet-status").textContent = `Connected ${connection.account} · ${usd(balance)} USDC on ${arc.name}`;
  $("#pay-choice").hidden = true;
  $("#create-card").hidden = false;
}

function chooseExchange() {
  mode = "exchange";
  $("#wallet-status").textContent =
    "You'll get a deposit address after setting up your drops. Withdraw USDC to it from your exchange, on the Arc network.";
  $("#pay-choice").hidden = true;
  $("#create-card").hidden = false;
}

// ------------------------------------------------------------------ create

function readForm(): Pick<Plan, "amount" | "count" | "expiresAt" | "feeCap"> {
  const amount = parseUsd($<HTMLInputElement>("#amount").value);
  const count = Number($<HTMLInputElement>("#count").value);
  const feeCap = parseUsd($<HTMLInputElement>("#fee-cap").value);
  const expiresMs = new Date($<HTMLInputElement>("#expires").value).getTime();

  if (amount <= 0n || amount > MAX_DROP) throw new Error("Each drop must be between $0.01 and $50.");
  if (!Number.isInteger(count) || count < 1 || count > MAX_PER_CALL) throw new Error("Make between 1 and 200 drops.");
  if (feeCap > MAX_FEE_CAP) throw new Error("The max network fee can be at most $0.10.");
  if (feeCap >= amount) throw new Error("The network fee must be smaller than the drop.");
  if (!(expiresMs > Date.now() + 60_000)) throw new Error("Pick a claim deadline in the future.");

  return { amount, count, feeCap, expiresAt: BigInt(Math.floor(expiresMs / 1000)) };
}

function createLinks() {
  const base = readForm();
  const secrets = Array.from({ length: base.count }, newClaimSecret);
  plan = {
    ...base,
    secrets,
    links: secrets.map((s) => claimLink(siteUrl(), s)),
    fundingKey: mode === "exchange" ? newClaimSecret() : undefined,
  };

  $("#backup-count").textContent = String(plan.count);
  $("#backup-extra").hidden = mode !== "exchange";
  $("#fund-summary").textContent = `${plan.count} drops × ${usd(plan.amount)} = ${usd(total(plan))}, plus a few cents of network fees.`;
  $("#fund-step").hidden = mode !== "wallet";
  $<HTMLButtonElement>("#fund").disabled = true;
  $("#fund-status").textContent = "Download the backup to continue.";
  $("#backup-card").hidden = false;
  $("#create-card").querySelector<HTMLButtonElement>("button[type=submit]")!.disabled = true;
  $("#backup-card").scrollIntoView({ behavior: "smooth" });
}

function downloadBackup(campaignId?: bigint) {
  if (!plan) return;
  const csv = backupCsv({ amountUsd: usd(plan.amount).slice(1), secrets: plan.secrets, links: plan.links, fundingKey: plan.fundingKey });
  downloadText(`dollar-drop-${campaignId ?? "backup"}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
}

function afterBackup() {
  if (!plan) return;
  if (mode === "wallet") {
    $<HTMLButtonElement>("#fund").disabled = false;
    $("#fund-status").textContent = "";
  } else {
    savePending(plan);
    showDeposit(plan);
  }
}

// ------------------------------------------------------------------ fund (shared by both modes)

async function fund(c: Connection, p: Plan, status: HTMLElement): Promise<bigint> {
  const contract = requireContract();
  const need = total(p);
  await ensureArc(c.wallet);

  const balance = await usdcBalance(c.account);
  if (balance < need) throw new Error(`You need ${usd(need)} but have ${usd(balance)}.`);

  const allowance = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: "allowance", args: [c.account, contract],
  });
  if (allowance < need) {
    status.textContent = "Step 1 of 2: approving Dollar Drop to use the USDC…";
    const hash = await c.wallet.writeContract({
      account: c.signer, chain: arc, address: USDC, abi: erc20Abi, functionName: "approve", args: [contract, need],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  status.textContent = "Step 2 of 2: funding the drops…";
  const keys = p.secrets.map((s) => privateKeyToAccount(s).address);
  const { request } = await publicClient.simulateContract({
    account: c.signer, address: contract, abi: dollarDropAbi, functionName: "createCampaign",
    args: [p.amount, p.expiresAt, p.feeCap, keys],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: await c.wallet.writeContract(request) });
  if (receipt.status !== "success") throw new Error("Funding failed. The USDC was not spent.");

  const [created] = parseEventLogs({ abi: dollarDropAbi, eventName: "CampaignCreated", logs: receipt.logs });
  p.funded = true;
  status.textContent = "";
  return created.args.campaignId;
}

async function fundFromWallet() {
  if (!plan || !connection) return;
  const campaignId = await fund(connection, plan, $("#fund-status"));
  await showFunded(campaignId);
}

// ------------------------------------------------------------------ exchange deposit

/** Fees for approve + createCampaign at a pessimistic gas price, with 50% headroom, rounded up to the cent. */
async function feeBudget(drops: number): Promise<bigint> {
  const gasPrice = await publicClient.getGasPrice();
  const maxFee = gasPrice * 2n > 20_000_000_000n ? gasPrice * 2n : 20_000_000_000n;
  const units = 60_000n + 160_000n + 26_000n * BigInt(drops); // measured: approve ~51k, create ~145k + 25.6k/drop
  const native = (units * maxFee * 3n) / 2n; // 18 decimals
  const usdcUnits = (native + 10n ** 12n - 1n) / 10n ** 12n;
  return ((usdcUnits + 9_999n) / 10_000n) * 10_000n;
}

function savePending(p: Plan) {
  const json = JSON.stringify(p, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
  localStorage.setItem(PENDING, json);
}

function loadPending(): Plan | null {
  const raw = localStorage.getItem(PENDING);
  if (!raw) return null;
  try {
    return JSON.parse(raw, (_, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as Plan;
  } catch {
    return null;
  }
}

async function showDeposit(p: Plan) {
  const funder = connectWithKey(p.fundingKey!);
  const need = total(p) + (await feeBudget(p.count));
  const card = $("#deposit-card");
  card.hidden = false;
  $("#deposit-address").textContent = funder.account;
  $("#deposit-amount").textContent = usd(need);
  $("#deposit-qr").setAttribute("src", await QRCode.toDataURL(funder.account, { margin: 1, width: 240 }));
  $("#copy-address").onclick = async () => {
    await navigator.clipboard.writeText(funder.account);
    $("#copy-address").textContent = "Copied";
  };
  card.scrollIntoView({ behavior: "smooth" });

  let funding = false;
  const check = async () => {
    if (funding) return;
    const have = await usdcBalance(funder.account);
    const pct = Number((have * 100n) / need);
    $("#deposit-progress").style.width = `${Math.min(100, pct)}%`;
    $("#deposit-status").textContent = have === 0n
      ? "Waiting for your deposit… This page checks every few seconds; keep it open."
      : have < need
        ? `${usd(have)} received. Send ${usd(need - have)} more to continue.`
        : `${usd(have)} received. Funding your drops…`;
    if (have < need) return;

    funding = true;
    window.clearInterval(poll);
    try {
      const campaignId = await fund(funder, p, $("#deposit-status"));
      localStorage.removeItem(PENDING);
      await showFunded(campaignId);
      const leftover = await usdcBalance(funder.account);
      if (leftover > 0n) {
        $("#leftover").hidden = false;
        $("#leftover").textContent =
          `${usd(leftover)} of unused fee money stays in your funding wallet. You can send it back to your exchange from the dashboard using your backup file.`;
      }
    } catch (e) {
      funding = false;
      $("#deposit-status").textContent = `${errorMessage(e)} Retrying…`;
      poll = window.setInterval(() => check().catch(console.error), POLL_MS);
    }
  };
  window.clearInterval(poll);
  poll = window.setInterval(() => check().catch(console.error), POLL_MS);
  await check();
}

// ------------------------------------------------------------------ funded

async function showFunded(campaignId: bigint) {
  if (!plan) return;
  $("#deposit-card").hidden = true;
  $("#campaign-id").textContent = `#${campaignId}`;
  $("#sheet-card").hidden = false;
  $("#sheet-card").scrollIntoView({ behavior: "smooth" });
  $("#download-again").onclick = () => downloadBackup(campaignId);
  $<HTMLAnchorElement>("#track").href = `/dashboard.html#campaign-${campaignId}`;
  const codes = await Promise.all(plan.links.map((l) => QRCode.toDataURL(l, { margin: 1, width: 360 })));
  $("#sheet").innerHTML = codes
    .map((src, i) => html`
      <figure class="ticket">
        <img src="${src}" alt="QR code for drop ${i + 1}" />
        <figcaption><strong>${usd(plan!.amount)}</strong><span>Scan to claim · #${campaignId}-${i + 1}</span></figcaption>
      </figure>`)
    .join("");
}

// ------------------------------------------------------------------ wiring

async function act(fn: () => Promise<void>, statusEl?: HTMLElement) {
  try {
    await fn();
  } catch (e) {
    console.error(e);
    const message = errorMessage(e);
    if (statusEl) statusEl.textContent = message;
    else alert(message);
  }
}

function defaultExpiry() {
  const d = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

$<HTMLInputElement>("#expires").value = defaultExpiry();
$("#network").textContent = arc.name;
document.querySelectorAll(".network-name").forEach((el) => (el.textContent = arc.name));
$("#connect").onclick = () => act(connect, $("#wallet-status"));
$("#use-exchange").onclick = chooseExchange;
$("#create-form").onsubmit = (e) => {
  e.preventDefault();
  act(async () => createLinks(), $("#form-error"));
};
$("#download-backup").onclick = () => {
  downloadBackup();
  afterBackup();
};
$("#fund").onclick = () => {
  const btn = $<HTMLButtonElement>("#fund");
  btn.disabled = true;
  act(fundFromWallet, $("#fund-status")).finally(() => (btn.disabled = Boolean(plan?.funded)));
};
$("#print").onclick = () => window.print();

// A deposit started earlier (tab closed, page reloaded): offer to pick it up again.
const pending = loadPending();
if (pending?.fundingKey) {
  $("#resume-card").hidden = false;
  $("#resume-summary").textContent = `${pending.count} drops × ${usd(pending.amount)}, waiting for a deposit to ${privateKeyToAccount(pending.fundingKey).address}.`;
  $("#resume").onclick = () => {
    plan = pending;
    mode = "exchange";
    $("#resume-card").hidden = true;
    $("#pay-choice").hidden = true;
    act(() => showDeposit(pending));
  };
  $("#discard").onclick = async () => {
    const held = await usdcBalance(privateKeyToAccount(pending.fundingKey!).address).catch(() => 0n);
    const warning = held > 0n
      ? `That funding wallet already holds ${usd(held)}. Only discard if you have the backup file: you'll need it to get the money back (Dashboard → Open with backup file). Discard?`
      : "Discard this unfunded campaign?";
    if (!confirm(warning)) return;
    localStorage.removeItem(PENDING);
    $("#resume-card").hidden = true;
  };
}
