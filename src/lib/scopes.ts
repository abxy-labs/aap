import type { Tier } from "../types.ts";

export const TIERS: Tier[] = ["observe", "read", "manage", "transact", "control"];

export const VOCABULARY: Record<string, { tier: Tier; text: string }> = {
  "public:read": { tier: "observe", text: "See pages that do not require signing in" },
  "accounts:read": { tier: "read", text: "See your accounts and balances" },
  "transactions:read": { tier: "read", text: "See your transaction history" },
  "documents:read": { tier: "read", text: "See your statements and documents" },
  "profile:read": { tier: "read", text: "See your contact information and settings" },
  "profile:write": { tier: "manage", text: "Change your contact information, alerts, and preferences" },
  "cards:manage": { tier: "manage", text: "Lock or unlock your cards and set travel notices" },
  "disputes:write": { tier: "manage", text: "File and follow up on disputes" },
  "support:write": { tier: "manage", text: "Send secure messages and book appointments" },
  "payments:initiate": { tier: "transact", text: "Make payments" },
  "transfers:initiate": { tier: "transact", text: "Move money between accounts" },
  "payees:write": { tier: "transact", text: "Add or edit payees" },
  "security:write": { tier: "control", text: "Change your password, security settings, or recovery contacts" },
};

export function tierOf(scope: string): Tier | undefined {
  return VOCABULARY[scope]?.tier;
}

export function tierIndex(tier: Tier | "none"): number {
  if (tier === "none") return -1;
  return TIERS.indexOf(tier);
}

export function maxTier(scopes: string[]): Tier | "none" {
  let best = -1;
  for (const s of scopes) {
    const t = tierOf(s);
    if (t === undefined) continue;
    best = Math.max(best, tierIndex(t));
  }
  return best < 0 ? "none" : TIERS[best]!;
}

export function isKnown(scope: string): boolean {
  return scope in VOCABULARY;
}

export function isSubset(a: string[], b: string[]): boolean {
  const set = new Set(b);
  return a.every((s) => set.has(s));
}

export function intersect(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((s) => set.has(s));
}

export function withinTier(scopes: string[], ceiling: Tier | "none"): string[] {
  const max = tierIndex(ceiling);
  return scopes.filter((s) => {
    const t = tierOf(s);
    return t !== undefined && t !== "control" && tierIndex(t) <= max;
  });
}

export function validate(scopes: string[]): string[] {
  const unknown = scopes.filter((s) => !isKnown(s));
  return unknown;
}
