// Tiny DOM helpers shared by the pages.

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Tagged template that escapes every interpolated value. Use raw() for trusted markup. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = values[i - 1];
    const text = v instanceof Raw ? v.value : escapeHtml(String(v ?? ""));
    return out + text + s;
  }, "");
}

class Raw {
  constructor(public value: string) {}
}
export const raw = (value: string) => new Raw(value);

export function $<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`missing element ${selector}`);
  return el;
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "shortMessage" in e) return String((e as { shortMessage: string }).shortMessage);
  return e instanceof Error ? e.message : String(e);
}

// Waits that can run long (Circle setting up a wallet, an Arc transaction, a slow relayer). Without a word
// after a while, a turning spinner looks stuck and people leave.
const HINTS: [number, string][] = [
  [8, "Still working. This step can take up to a minute."],
  [30, "Taking longer than usual. Keep this page open; it will finish on its own."],
];

/** A spinner with its message, plus a line that fills in as time passes; call startHints() once it's shown. */
export function spinner(message: string): string {
  return html`<div class="spinner" aria-hidden="true"></div><p class="center">${message}</p>
    <p class="center muted small busy-hint" aria-live="polite"></p>`;
}

/** Fill in the hint line under spinner() over time; stops on its own once the spinner is replaced. */
export function startHints(root: ParentNode) {
  const hint = root.querySelector<HTMLElement>(".busy-hint");
  if (!hint) return;
  for (const [after, text] of HINTS) setTimeout(() => hint.isConnected && (hint.textContent = text), after * 1000);
}
