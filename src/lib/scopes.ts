export interface ScopeDef {
  text: string;
  /** The step can only ever be completed by the consumer on the site. */
  customer_action_only?: boolean;
  /** Context fields an agent supplies when it asks for a customer_action on this scope. */
  context?: { required: string[]; optional: string[] };
}

export const VOCABULARY: Record<string, ScopeDef> = {
  "public:read": { text: "See pages that do not require signing in" },
  "accounts:read": { text: "See your accounts and balances" },
  "transactions:read": { text: "See your transaction history" },
  "documents:read": { text: "See your statements and documents" },
  "profile:read": { text: "See your contact information and settings" },
  "profile:write": { text: "Change your contact information, alerts, and preferences" },
  "cards:manage": { text: "Lock or unlock your cards and set travel notices" },
  "disputes:write": { text: "File and follow up on disputes" },
  "support:write": { text: "Send secure messages and book appointments" },
  "application:write": { text: "Fill out and submit an application", context: { required: [], optional: ["application"] } },
  "identity:verify": { text: "Verify your identity", customer_action_only: true, context: { required: [], optional: ["application"] } },
  "payments:initiate": { text: "Make payments", context: { required: ["amount", "currency", "payee"], optional: ["memo", "date"] } },
  "transfers:initiate": { text: "Move money between accounts", context: { required: ["amount", "currency"], optional: ["from", "to", "memo"] } },
  "payees:write": { text: "Add or edit payees", context: { required: ["payee"], optional: ["details"] } },
  "security:write": { text: "Change your password, security settings, or recovery contacts" },
};

export function isCustomerActionOnly(scope: string): boolean {
  return VOCABULARY[scope]?.customer_action_only === true;
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

export function validate(scopes: string[]): string[] {
  return scopes.filter((s) => !isKnown(s));
}
