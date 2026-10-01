// Organizer page: create, fund, print and manage drops.
//
// Claim keys are generated here, in the organizer's browser. Only their addresses go on-chain.
// The organizer must download the backup before funding: without the links, drops can't be
// claimed (though they can still be found via DropCreated events and refunded).
import {
  type Address,
  type Hex,
  type WalletClient,
  createWalletClient,
  custom,
  erc20Abi,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import QRCode from "qrcode";
import { USDC, arc, config, publicClient, requireContract } from "./config";
import { usd, parseUsd } from "./format";
import { dollarDropAbi } from "./generated/abi";
import { claimLink, newClaimSecret } from "./links";
import { $, errorMessage, html } from "./ui";

const MAX_DROP = 50_000_000n;
const MAX_FEE_CAP = 100_000n;
const MAX_PER_CALL = 200;
const STATUS = ["none", "active", "claimed", "refunded"] as const;

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
  if (!window.ethereum) throw new Error("No browser wallet found. Install MetaMask or a similar wallet, then reload.");
  wallet = createWalletClient({ chain: arc, transport: custom(window.ethereum) });
  [account] = await wallet.requestAddresses();
  await ensureArc();

  const balance = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account] });
  $("#wallet-status").textContent = `Connected ${account} · ${usd(balance)} USDC on ${arc.name}`;
  $("#connect").hidden = true;
  $("#create-card").hidden = false;
  $("#manage-card").hidden = false;
}

async function ensureArc() {
  if ((await wallet.getChainId()) === arc.id) return;
  try {
    await wallet.switchChain({ id: arc.id });
  } catch {
    await wallet.addChain({ chain: arc });
    await wallet.switchChain({ id: arc.id });
  }
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
  await ensureArc();

  const balance = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account] });
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

// ------------------------------------------------------------------ manage

async function lookUp(campaignId: bigint) {
  const contract = requireContract();
  const out = $("#manage-out");
  out.textContent = "Loading…";

  const [owner, amount, expiresAt, , paused] = await publicClient.readContract({
    address: contract, abi: dollarDropAbi, functionName: "campaigns", args: [campaignId],
  });
  if (owner === "0x0000000000000000000000000000000000000000") throw new Error("No campaign with that number.");

  const logs = await publicClient.getContractEvents({
    address: contract, abi: dollarDropAbi, eventName: "DropCreated",
    args: { campaignId }, fromBlock: config.deployBlock, toBlock: "latest",
  });
  const keys = logs.map((l) => l.args.claimKey!);
  const drops = await Promise.all(
    keys.map((k) => publicClient.readContract({ address: contract, abi: dollarDropAbi, functionName: "getDrop", args: [k] })),
  );
  const counts = { active: 0, claimed: 0, refunded: 0 };
  const unclaimed: Address[] = [];
  drops.forEach((d, i) => {
    const s = STATUS[d[1]];
    if (s !== "none") counts[s]++;
    if (s === "active") unclaimed.push(keys[i]);
  });
  const isOwner = owner.toLowerCase() === account.toLowerCase();

  out.innerHTML = html`
    <table class="stats">
      <tr><th>Drop size</th><td>${usd(amount)}</td></tr>
      <tr><th>Claimed</th><td>${counts.claimed} of ${keys.length}</td></tr>
      <tr><th>Unclaimed</th><td>${counts.active} (${usd(amount * BigInt(counts.active))})</td></tr>
      <tr><th>Refunded</th><td>${counts.refunded}</td></tr>
      <tr><th>Claim deadline</th><td>${new Date(Number(expiresAt) * 1000).toLocaleString()}</td></tr>
      <tr><th>Status</th><td>${paused ? "Paused" : "Open"}</td></tr>
    </table>
    ${isOwner ? "" : "Only the wallet that created this campaign can change it."}`;

  if (!isOwner) return;
  const row = document.createElement("div");
  row.className = "row";
  const pause = Object.assign(document.createElement("button"), {
    className: "btn", textContent: paused ? "Resume claims" : "Pause claims",
  });
  pause.onclick = () => act(async () => {
    const { request } = await publicClient.simulateContract({
      account, address: contract, abi: dollarDropAbi, functionName: "setPaused", args: [campaignId, !paused],
    });
    await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
    await lookUp(campaignId);
  });
  row.append(pause);

  if (unclaimed.length) {
    const refund = Object.assign(document.createElement("button"), {
      className: "btn danger", textContent: `Refund ${unclaimed.length} unclaimed (${usd(amount * BigInt(unclaimed.length))})`,
    });
    refund.onclick = () => act(async () => {
      if (!confirm("Refund every unclaimed drop? Their links will stop working.")) return;
      for (let i = 0; i < unclaimed.length; i += MAX_PER_CALL) {
        const { request } = await publicClient.simulateContract({
          account, address: contract, abi: dollarDropAbi, functionName: "refund", args: [unclaimed.slice(i, i + MAX_PER_CALL)],
        });
        await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
      }
      await lookUp(campaignId);
    });
    row.append(refund);
  }
  out.append(row);
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
$("#manage-form").onsubmit = (e) => {
  e.preventDefault();
  act(() => lookUp(BigInt($<HTMLInputElement>("#manage-id").value)), $("#manage-out"));
};
