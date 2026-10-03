// Organizer page: create, fund and print drops. Tracking, pausing and refunds live in the dashboard.
//
// Claim keys are generated here, in the organizer's browser. Only their addresses go on-chain.
// The organizer must download the backup before funding: without the links, drops can't be
// claimed (though they can still be found via DropCreated events and refunded).
import { type Address, type Hex, type WalletClient, erc20Abi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import QRCode from "qrcode";
import { USDC, arc, publicClient, requireContract } from "./config";
import { connectWallet, ensureArc, usdcBalance } from "./connect";
import { usd, parseUsd } from "./format";
import { dollarDropAbi } from "./generated/abi";
import { claimLink, newClaimSecret } from "./links";
import { renderNav } from "./nav";
import { $, errorMessage, html } from "./ui";

renderNav();

const MAX_DROP = 50_000_000n;
const MAX_FEE_CAP = 100_000n;
const MAX_PER_CALL = 200;

let wallet: WalletClient;
let account: Address;

interface Plan {
  amount: bigint;
  count: number;
  expiresAt: bigint;
  feeCap: bigint;
  secrets: Hex[];
  links: string[];
  funded?: boolean;
}
let plan: Plan | undefined;

const siteUrl = () => location.origin + location.pathname.replace(/[^/]*$/, "");

// ------------------------------------------------------------------ wallet

async function connect() {
  ({ wallet, account } = await connectWallet());
  const balance = await usdcBalance(account);
  $("#wallet-status").textContent = `Connected ${account} · ${usd(balance)} USDC on ${arc.name}`;
  $("#connect").hidden = true;
  $("#create-card").hidden = false;
}

// ------------------------------------------------------------------ create

function readForm(): Omit<Plan, "secrets" | "links"> {
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
  plan = { ...base, secrets, links: secrets.map((s) => claimLink(siteUrl(), s)) };

  $("#backup-count").textContent = String(plan.count);
  $("#fund-summary").textContent =
    `${plan.count} drops × ${usd(plan.amount)} = ${usd(plan.amount * BigInt(plan.count))}, plus network fees for 2 transactions.`;
  $<HTMLButtonElement>("#fund").disabled = true;
  $("#fund-status").textContent = "Download the backup to continue.";
  $("#backup-card").hidden = false;
  $("#backup-card").scrollIntoView({ behavior: "smooth" });
}

function downloadCsv(campaignId?: bigint) {
  if (!plan) return;
  const rows = [["drop", "amount_usd", "claim_key", "link"]];
  plan.secrets.forEach((s, i) => {
    rows.push([String(i + 1), usd(plan!.amount).slice(1), privateKeyToAccount(s).address, plan!.links[i]]);
  });
  const blob = new Blob([rows.map((r) => r.join(",")).join("\n") + "\n"], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `dollar-drop-${campaignId ?? "backup"}-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------------ fund

async function fund() {
  if (!plan) return;
  const contract = requireContract();
  const status = $("#fund-status");
  const total = plan.amount * BigInt(plan.count);
  await ensureArc(wallet);

  const balance = await usdcBalance(account);
  if (balance < total) throw new Error(`You need ${usd(total)} but have ${usd(balance)}.`);

  const allowance = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: "allowance", args: [account, contract],
  });
  if (allowance < total) {
    status.textContent = "Step 1 of 2: approve Dollar Drop to use your USDC…";
    const hash = await wallet.writeContract({
      account, chain: arc, address: USDC, abi: erc20Abi, functionName: "approve", args: [contract, total],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  status.textContent = "Step 2 of 2: fund the drops…";
  const keys = plan.secrets.map((s) => privateKeyToAccount(s).address);
  const { request } = await publicClient.simulateContract({
    account, address: contract, abi: dollarDropAbi, functionName: "createCampaign",
    args: [plan.amount, plan.expiresAt, plan.feeCap, keys],
  });
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Funding failed. Your USDC was not spent.");

  const [created] = parseEventLogs({ abi: dollarDropAbi, eventName: "CampaignCreated", logs: receipt.logs });
  const campaignId = created.args.campaignId;
  plan.funded = true;
  status.textContent = "";
  $("#campaign-id").textContent = `#${campaignId}`;
  $("#sheet-card").hidden = false;
  $("#sheet-card").scrollIntoView({ behavior: "smooth" });
  $("#download-again").onclick = () => downloadCsv(campaignId);
  $<HTMLAnchorElement>("#track").href = `/dashboard.html#campaign-${campaignId}`;
  await renderSheet(campaignId);
}

async function renderSheet(campaignId: bigint) {
  if (!plan) return;
  const codes = await Promise.all(plan.links.map((l) => QRCode.toDataURL(l, { margin: 1, width: 360 })));
  $("#sheet").innerHTML = codes
    .map(
      (src, i) => html`
        <figure class="ticket">
          <img src="${src}" alt="QR code for drop ${i + 1}" />
          <figcaption><strong>${usd(plan!.amount)}</strong><span>Scan to claim · #${campaignId}-${i + 1}</span></figcaption>
        </figure>`,
    )
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
$("#connect").onclick = () => act(connect, $("#wallet-status"));
$("#create-form").onsubmit = (e) => {
  e.preventDefault();
  act(async () => createLinks());
};
$("#download-backup").onclick = () => {
  downloadCsv();
  $<HTMLButtonElement>("#fund").disabled = false;
  $("#fund-status").textContent = "";
};
$("#fund").onclick = () => {
  const btn = $<HTMLButtonElement>("#fund");
  btn.disabled = true;
  act(fund, $("#fund-status")).finally(() => (btn.disabled = Boolean(plan?.funded)));
};
$("#print").onclick = () => window.print();
