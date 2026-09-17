import type { Constraints } from "../types.ts";

function minNum(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** The more restrictive of two constraint sets. The second set's currency wins when both are set. */
export function intersectConstraints(a: Constraints, b: Constraints): Constraints {
  const out: Constraints = {};
  const currency = b.currency ?? a.currency;
  if (currency) out.currency = currency;
  const amount = minNum(a.max_amount, b.max_amount);
  if (amount !== undefined) out.max_amount = amount;
  const total = minNum(a.max_total, b.max_total);
  if (total !== undefined) out.max_total = total;
  const count = minNum(a.max_count, b.max_count);
  if (count !== undefined) out.max_count = count;
  if (a.payees === "existing_only" || b.payees === "existing_only") out.payees = "existing_only";
  else if (a.payees || b.payees) out.payees = "any";
  const ttl = minNum(a.ttl_s, b.ttl_s);
  if (ttl !== undefined) out.ttl_s = ttl;
  return out;
}

/** True when `a` is at least as restrictive as `b` in every field `b` sets. */
export function isAtLeastAsRestrictive(a: Constraints, b: Constraints): boolean {
  if (b.max_amount !== undefined && (a.max_amount === undefined || a.max_amount > b.max_amount)) return false;
  if (b.max_total !== undefined && (a.max_total === undefined || a.max_total > b.max_total)) return false;
  if (b.max_count !== undefined && (a.max_count === undefined || a.max_count > b.max_count)) return false;
  if (b.payees === "existing_only" && a.payees !== "existing_only") return false;
  if (b.ttl_s !== undefined && (a.ttl_s === undefined || a.ttl_s > b.ttl_s)) return false;
  return true;
}

const ZERO_DECIMAL = new Set(["jpy", "krw", "vnd", "clp", "isk", "huf"]);

/** Format a minor-unit amount for a consumer, for example 20000 USD as $200 and 14210 USD as $142.10. */
export function formatAmount(minor: number, currency = "usd"): string {
  const zero = ZERO_DECIMAL.has(currency.toLowerCase());
  const value = zero ? minor : minor / 100;
  const whole = zero || minor % 100 === 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(value);
  } catch {
    return `${value} ${currency.toUpperCase()}`;
  }
}

export function validateConstraints(c: Constraints): string | null {
  for (const k of ["max_amount", "max_total", "max_count", "ttl_s"] as const) {
    const v = c[k];
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) return `${k} must be a non-negative integer`;
  }
  if (c.payees !== undefined && c.payees !== "existing_only" && c.payees !== "any") return "payees must be existing_only or any";
  if (c.currency !== undefined && !/^[a-z]{3}$/i.test(c.currency)) return "currency must be a three-letter code";
  return null;
}
