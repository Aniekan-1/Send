// Claim page: open a link, get dollars.
//
// Security notes
// - The claim key secret comes from the "#k=" part of the link. We move it into sessionStorage
//   (this tab only) and strip it from the address bar so it doesn't linger in history or screenshots.
// - The secret never leaves the browser: we sign Claim(recipient, relayer, fee) here and send only
//   the signature to the relayer.
import { type Address, type Hex, getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ApiError, type DropInfo, api } from "./api";
import { PENDING_GOOGLE, circleEnabled, config, googleEnabled, txLink } from "./config";
import { signClaim } from "./eip712";
import { dateTime, shortAddress, usd } from "./format";
import { secretFromHash } from "./links";
import { renderNav } from "./nav";
import { $, errorMessage, html, raw } from "./ui";

renderNav({ minimal: true });

const SECRET = "dd:claim-secret";
const app = $("#app");

let secret: Hex;
let drop: DropInfo;
let circleAvailable = false;
let recipientIsCircle = false;

// Loaded on demand so the claim page works even if the Circle SDK can't load.
const circle = () => import("./circle");

// ------------------------------------------------------------------ views

function show(markup: string) {
  app.innerHTML = markup;
}

function showError(title: string, detail?: string) {
  show(html`<h1>${title}</h1>${detail ? raw(html`<p class="muted">${detail}</p>`) : ""}`);
}

function amountHeader() {
  return html`
    <p class="eyebrow">You've been sent</p>
    <p class="amount">${usd(drop.receive)}</p>
    <p class="muted small">
      ${usd(drop.amount)} drop, minus a ${usd(drop.fee)} network fee. Claim by ${dateTime(drop.expires_at)}.
    </p>`;
}

function showChoose() {
  const circleButtons = circleAvailable
    ? html`
        ${googleEnabled() ? raw(`<button class="btn primary" data-act="google">Continue with Google</button>`) : ""}
        <button class="btn ${googleEnabled() ? "" : "primary"}" data-act="email">Continue with email</button>
        <p class="muted small center">We'll create a free wallet for you. Only you control it.</p>
        <div class="divider"><span>or</span></div>`
    : "";

  show(html`
    ${raw(amountHeader())}
    <div class="stack">
      ${raw(circleButtons)}
      <button class="btn ${circleAvailable ? "ghost" : "primary"}" data-act="own">I already have a wallet</button>
    </div>`);

  app.querySelector("[data-act=google]")?.addEventListener("click", () => run(async () => (await circle()).startGoogleLogin()));
  app.querySelector("[data-act=email]")?.addEventListener("click", showEmail);
  $("[data-act=own]", app).addEventListener("click", showOwnWallet);
}

function showEmail() {
  show(html`
    ${raw(amountHeader())}
    <form class="stack" id="email-form">
      <label for="email">Your email</label>
      <input id="email" type="email" autocomplete="email" required placeholder="you@example.com" />
      <button class="btn primary" type="submit">Email me a code</button>
      <button class="btn ghost" type="button" data-act="back">Back</button>
    </form>`);
  $("[data-act=back]", app).addEventListener("click", showChoose);
  $("#email-form", app).addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $<HTMLInputElement>("#email", app).value.trim();
    run(async () => {
      busy("Check your inbox for a code…");
      const { emailLogin, saveSession, walletAddress } = await circle();
      const session = await emailLogin(email);
      saveSession(session);
      busy("Setting up your wallet…");
      const address = await walletAddress(session);
      showConfirm(address, "your new wallet", true);
    });
  });
}

function showOwnWallet() {
  const hasBrowserWallet = Boolean(window.ethereum);
  show(html`
    ${raw(amountHeader())}
    <form class="stack" id="own-form">
      ${hasBrowserWallet ? raw(`<button class="btn primary" type="button" data-act="connect">Use my browser wallet</button>`) : ""}
      <label for="address">Or paste your wallet address</label>
      <input id="address" autocomplete="off" spellcheck="false" placeholder="0x…" />
      <button class="btn ${hasBrowserWallet ? "" : "primary"}" type="submit">Continue</button>
      <button class="btn ghost" type="button" data-act="back">Back</button>
    </form>`);

  $("[data-act=back]", app).addEventListener("click", showChoose);
  app.querySelector("[data-act=connect]")?.addEventListener("click", () =>
    run(async () => {
      const [address] = (await window.ethereum!.request({ method: "eth_requestAccounts" })) as string[];
      showConfirm(getAddress(address), "your browser wallet");
    }),
  );
  $("#own-form", app).addEventListener("submit", (e) => {
    e.preventDefault();
    const value = $<HTMLInputElement>("#address", app).value.trim();
    if (!isAddress(value)) return alert("That doesn't look like a wallet address (it should start with 0x).");
    showConfirm(getAddress(value), "this wallet");
  });
}

function showConfirm(recipient: Address, label: string, viaCircle = false) {
  recipientIsCircle = viaCircle;
  show(html`
    ${raw(amountHeader())}
    <div class="stack">
      <p>Send <strong>${usd(drop.receive)}</strong> to ${label}<br /><code>${shortAddress(recipient)}</code></p>
      <button class="btn primary" data-act="claim">Claim ${usd(drop.receive)}</button>
      <button class="btn ghost" data-act="back">Use a different wallet</button>
    </div>`);
  $("[data-act=back]", app).addEventListener("click", showChoose);
  $("[data-act=claim]", app).addEventListener("click", () => run(() => claim(recipient)));
}

function busy(message: string) {
  show(html`<div class="spinner" aria-hidden="true"></div><p class="center">${message}</p>`);
}

function showDone(txHash: string, recipient: Address, amount: number, circleWallet: boolean) {
  const link = txLink(txHash);
  const next = circleWallet
    ? html`<a class="btn primary" href="/wallet.html">Open my wallet</a>
        <p class="center muted small">Send it to a friend or an exchange from your wallet.</p>`
    : html`<p class="center muted small">Want to cash out? <a href="/wallet.html#cash-out">Here's how</a>.</p>`;
  show(html`
    <p class="big-check" aria-hidden="true">✓</p>
    <h1 class="center">${usd(amount)} is yours</h1>
    <p class="center muted">It's in <code>${shortAddress(recipient)}</code>, ready to spend or send.</p>
    ${link ? raw(html`<p class="center"><a href="${link}" target="_blank" rel="noopener">View the transaction</a></p>`) : ""}
    <div class="stack">${raw(next)}</div>`);
}

// ------------------------------------------------------------------ actions

async function run(action: () => Promise<void>) {
  try {
    await action();
  } catch (e) {
    console.error(e);
    show(html`
      ${raw(amountHeader())}
      <p class="error">${errorMessage(e)}</p>
      <button class="btn primary" data-act="retry">Try again</button>`);
    $("[data-act=retry]", app).addEventListener("click", showChoose);
  }
}

async function claim(recipient: Address) {
  busy("Sending your dollars…");
  const signature = await signClaim(secret, {
    chainId: drop.chainId,
    contract: drop.contract,
    recipient,
    relayer: drop.relayer,
    fee: BigInt(drop.fee),
  });
  try {
    const result = await api.claim({ claimKey: drop.claim_key, recipient, fee: drop.fee, signature });
    sessionStorage.removeItem(SECRET);
    showDone(result.txHash, result.recipient, result.amount, recipientIsCircle);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return explainUnavailable(e.detail);
    throw e;
  }
}

function explainUnavailable(reason: string) {
  const messages: Record<string, [string, string]> = {
    claimed: ["Already claimed", "Someone has already claimed this drop. Each link works once."],
    refunded: ["Drop cancelled", "The organizer cancelled this drop."],
    AlreadyClaimed: ["You've already claimed one", "This wallet already claimed a drop from this campaign."],
    CampaignPaused: ["Paused", "The organizer has paused this campaign. Try again later."],
    CampaignExpired: ["Expired", "This drop has expired."],
  };
  const key = Object.keys(messages).find((k) => reason.includes(k));
  const [title, detail] = key ? messages[key] : ["Can't claim this drop", reason];
  showError(title, detail);
}

// ------------------------------------------------------------------ start

function loadSecret(): Hex | null {
  const fromLink = secretFromHash(location.hash);
  if (fromLink) {
    sessionStorage.setItem(SECRET, fromLink);
    history.replaceState(null, "", location.pathname + location.search);
    return fromLink;
  }
  return sessionStorage.getItem(SECRET) as Hex | null;
}

async function main() {
  const s = loadSecret();
  if (!s) return showError("This link is incomplete", "Ask the sender for the full link or QR code.");
  secret = s;

  try {
    const [info, health] = await Promise.all([
      api.drop(privateKeyToAccount(secret).address),
      api.health().catch(() => null),
    ]);
    drop = info;
    circleAvailable = circleEnabled() && Boolean(health?.circle);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return showError("Drop not found", "This link isn't valid.");
    return showError("Something went wrong", errorMessage(e));
  }

  if (drop.chainId !== config.chainId) console.warn("relayer chain differs from page config", drop.chainId);
  if (drop.status !== "active") return explainUnavailable(drop.status);
  if (drop.paused) return explainUnavailable("CampaignPaused");
  if (drop.expires_at * 1000 <= Date.now()) return explainUnavailable("CampaignExpired");

  if (sessionStorage.getItem(PENDING_GOOGLE)) {
    busy("Signing you in…");
    return run(async () => {
      const { resumeGoogleLogin, saveSession, walletAddress } = await circle();
      const pending = resumeGoogleLogin();
      if (!pending) return showChoose();
      const session = await pending;
      saveSession(session);
      busy("Setting up your wallet…");
      showConfirm(await walletAddress(session), "your new wallet", true);
    });
  }
  showChoose();
}

main();
