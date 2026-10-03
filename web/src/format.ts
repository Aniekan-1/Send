import { formatUnits, parseUnits } from "viem";

/** 6-decimal USDC units -> "$9.99" (more decimals only when needed, e.g. "$0.0042"). */
export function usd(units: bigint | number): string {
  const value = Number(formatUnits(BigInt(units), 6));
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return "$" + value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** "10.50" -> 10_500_000n. Throws on anything that isn't a plain positive amount. */
export function parseUsd(text: string): bigint {
  const clean = text.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,6})?$/.test(clean)) throw new Error(`"${text}" is not a dollar amount`);
  return parseUnits(clean, 6);
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function dateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Compact dollars for tiles and axes: $950, $12.4K, $1.2M. */
export function usdCompact(units: bigint | number): string {
  const value = Number(formatUnits(BigInt(units), 6));
  if (Math.abs(value) < 1000) return usd(units);
  return "$" + new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function count(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", else a date. */
export function ago(unixSeconds: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - unixSeconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} day${s < 2 * 86_400 ? "" : "s"} ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** "2026-10-03" -> "Oct 3" (UTC, matching the server's day buckets). */
export function shortDay(isoDate: string): string {
  return new Date(isoDate + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "1 person", "3 people": count + the right word. */
export function plural(n: number, one: string, many = one + "s"): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}
