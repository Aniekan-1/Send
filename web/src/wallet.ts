// My wallet: for people who signed in with Google or email when claiming.
//
// Their Circle wallet can only be used through this app, so this page is how they see their
// balance and send USDC on (to a friend, or to an exchange to cash out). Every payment is
// approved by the user in Circle's own screen; we never hold their keys.
import { type Address, erc20Abi, formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { PENDING_GOOGLE, USDC, circleEnabled, googleEnabled, publicClient } from "./config";
import { shortAddress, usd } from "./format";
import { $, errorMessage, html, raw } from "./ui";

// Left behind on "Max" so the send can pay its own network fee (a fraction of a cent on Arc).
const FEE_RESERVE = parseUnits("0.01", 6);

const app = $("#app");
const circle = () => import("./circle");

let session: import("./circle").Session;
let address: Address;
let balance = 0n;

function show(markup: string) {
  app.innerHTML = markup;
}

function busy(message: string) {
  show(html`<div class="spinner" aria-hidden="true"></div><p class="center">${message}</p>`);
}

// ------------------------------------------------------------------ signed out

function showSignIn(note = "") {
  if (!circleEnabled()) {
    show(html`
      <h1>My wallet</h1>
      <p class="muted">Sign-in isn't available here yet. If you claimed into your own wallet (like MetaMask), use that wallet to send or cash out; the steps below still apply.</p>`);
    return;
  }
  show(html`
    <h1>My wallet</h1>
    <p class="muted">Sign in the same way you did when you claimed your dollars.</p>
    ${note ? raw(html`<p class="error">${note}</p>`) : ""}
    <div class="stack">
      ${googleEnabled() ? raw(`<button class="btn primary" data-act="google">Continue with Google</button>`) : ""}
      <form class="stack" id="email-form">
        <label for="email">Or with email</label>
        <input id="email" type="email" autocomplete="email" required placeholder="you@example.com" />
        <button class="btn ${googleEnabled() ? "" : "primary"}" type="submit">Email me a code</button>
      </form>
    </div>`);

  app.querySelector("[data-act=google]")?.addEventListener("click", () =>
    run(async () => (await circle()).startGoogleLogin()),
  );
  $("#email-form", app).addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $<HTMLInputElement>("#email", app).value.trim();
    run(async () => {
      busy("Check your inbox for a code…");
      const c = await circle();
      const s = await c.emailLogin(email);
      c.saveSession(s);
      await open(s);
    });
  });
}

// ------------------------------------------------------------------ signed in

async function refreshBalance() {
  balance = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });
}

async function open(s: import("./circle").Session) {
  session = s;
  busy("Opening your wallet…");
  address = await (await circle()).walletAddress(session);
  await refreshBalance();
  showWallet();
}

function showWallet(message = "") {
  show(html`
    <p class="eyebrow">Your balance</p>
    <p class="amount">${usd(balance)}</p>
    <p class="muted small">
      USDC on Arc · <code title="${address}">${shortAddress(address)}</code>
      <button class="btn ghost small" data-act="copy" type="button">Copy address</button>
    </p>
    ${message ? raw(html`<p class="ok">${message}</p>`) : ""}

    <form class="stack" id="send-form" novalidate>
      <h2>Send</h2>
      <label for="to">To (an Arc address)</label>
      <input id="to" autocomplete="off" spellcheck="false" placeholder="0x…" required />
      <label for="amount">Amount (USD)</label>
      <div class="row tight">
        <input id="amount" inputmode="decimal" placeholder="0.00" required />
        <button class="btn" type="button" data-act="max">Max</button>
      </div>
      <p class="error small" id="send-error" hidden></p>
      <button class="btn primary" type="submit" ${balance > FEE_RESERVE ? "" : "disabled"}>Review payment</button>
    </form>
    <div class="row">
      <button class="btn ghost" data-act="refresh" type="button">Refresh</button>
      <button class="btn ghost" data-act="signout" type="button">Sign out</button>
    </div>`);

  $("[data-act=copy]", app).addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(address);
    (e.target as HTMLButtonElement).textContent = "Copied";
  });
  $("[data-act=max]", app).addEventListener("click", () => {
    const max = balance > FEE_RESERVE ? balance - FEE_RESERVE : 0n;
    $<HTMLInputElement>("#amount", app).value = formatUnits(max, 6);
  });
  $("[data-act=refresh]", app).addEventListener("click", () =>
    run(async () => {
      await refreshBalance();
      showWallet();
    }),
  );
  $("[data-act=signout]", app).addEventListener("click", async () => {
    (await circle()).clearSession();
    showSignIn();
  });
  $("#send-form", app).addEventListener("submit", (e) => {
    e.preventDefault();
    const problem = validateSend();
    const err = $("#send-error", app);
    if (typeof problem === "string") {
      err.textContent = problem;
      err.hidden = false;
      return;
    }
    showReview(problem.to, problem.amount);
  });
}

function validateSend(): string | { to: Address; amount: bigint } {
  const toText = $<HTMLInputElement>("#to", app).value.trim();
  const amountText = $<HTMLInputElement>("#amount", app).value.trim().replace(/^\$/, "");
  if (!isAddress(toText)) return "That doesn't look like an Arc address (it should start with 0x).";
  const to = getAddress(toText);
  if (to === address) return "That's your own address.";
  if (to === USDC || to === "0x0000000000000000000000000000000000000000") return "That address can't receive money.";
  if (!/^\d+(\.\d{1,6})?$/.test(amountText)) return "Enter an amount like 5 or 5.25.";
  const amount = parseUnits(amountText, 6);
  if (amount <= 0n) return "Enter an amount above zero.";
  if (amount + FEE_RESERVE > balance) return `You can send up to ${usd(balance > FEE_RESERVE ? balance - FEE_RESERVE : 0n)} (a cent stays behind for the network fee).`;
  return { to, amount };
}

function showReview(to: Address, amount: bigint) {
  show(html`
    <h1>Send ${usd(amount)}?</h1>
    <p>To <code>${to}</code></p>
    <p class="error small">Check the address carefully. Payments can't be reversed. If it's an exchange, make sure you chose the Arc network there.</p>
    <div class="stack">
      <button class="btn primary" data-act="send">Send ${usd(amount)}</button>
      <button class="btn ghost" data-act="back">Back</button>
    </div>`);
  $("[data-act=back]", app).addEventListener("click", () => showWallet());
  $("[data-act=send]", app).addEventListener("click", () =>
    run(async () => {
      busy("Approve the payment in the window that opens…");
      await (await circle()).sendUsdc(session, to, formatUnits(amount, 6));
      busy("Sending…");
      const before = balance;
      for (let i = 0; i < 15 && balance === before; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        await refreshBalance();
      }
      showWallet(balance === before ? "Payment submitted. It can take a moment to show up." : `Sent ${usd(amount)}.`);
    }),
  );
}

// ------------------------------------------------------------------ start

async function run(action: () => Promise<void>) {
  try {
    await action();
  } catch (e) {
    console.error(e);
    const message = errorMessage(e);
    if (address) showWallet();
    else showSignIn(message);
    if (address) {
      const err = app.querySelector<HTMLElement>("#send-error");
      if (err) {
        err.textContent = message;
        err.hidden = false;
      }
    }
  }
}

async function main() {
  if (!circleEnabled()) return showSignIn();
  const c = await circle().catch(() => null);
  if (!c) return showSignIn("Sign-in couldn't load. Please refresh the page.");

  if (sessionStorage.getItem(PENDING_GOOGLE)) {
    busy("Signing you in…");
    return run(async () => {
      const pending = c.resumeGoogleLogin();
      if (!pending) return showSignIn();
      const s = await pending;
      c.saveSession(s);
      await open(s);
    });
  }

  const saved = c.loadSession();
  if (!saved) return showSignIn();
  try {
    await open(saved);
  } catch {
    c.clearSession(); // usually an expired sign-in
    showSignIn("Please sign in again.");
  }
}

main();
