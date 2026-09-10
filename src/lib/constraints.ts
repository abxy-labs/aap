import type { Constraints, Money } from "../types.ts";

function minMoney(a?: Money, b?: Money): Money | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.currency !== b.currency) return a.value <= b.value ? a : b;
  return a.value <= b.value ? a : b;
}

function minNum(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

export function intersectConstraints(a: Constraints, b: Constraints): Constraints {
  const out: Constraints = {};
  const amount = minMoney(a.max_amount, b.max_amount);
  if (amount) out.max_amount = amount;
  const total = minMoney(a.max_total, b.max_total);
  if (total) out.max_total = total;
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
  if (b.max_amount && (!a.max_amount || a.max_amount.value > b.max_amount.value)) return false;
  if (b.max_total && (!a.max_total || a.max_total.value > b.max_total.value)) return false;
  if (b.max_count !== undefined && (a.max_count === undefined || a.max_count > b.max_count)) return false;
  if (b.payees === "existing_only" && a.payees !== "existing_only") return false;
  if (b.ttl_s !== undefined && (a.ttl_s === undefined || a.ttl_s > b.ttl_s)) return false;
  return true;
}

export function describeMoney(m: Money): string {
  const symbols: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };
  const sym = symbols[m.currency];
  return sym ? `${sym}${m.value}` : `${m.value} ${m.currency}`;
}
