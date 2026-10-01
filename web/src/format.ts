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
