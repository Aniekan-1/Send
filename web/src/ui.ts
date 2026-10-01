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
