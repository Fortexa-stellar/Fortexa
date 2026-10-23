export function normalizeDomain(input: string | undefined | null): string | null {
  if (!input) {
    return null;
  }

  let domain = input.trim();

  if (!domain) {
    return null;
  }

  // Try to parse URL-like inputs to extract the hostname
  if (domain.includes("://")) {
    try {
      const url = new URL(domain);
      domain = url.hostname;
    } catch {
      return null;
    }
  }

  // Remove trailing dots
  domain = domain.replace(/\.+$/, "");

  // Convert to lowercase
  domain = domain.toLowerCase();

  // Basic validation: ensure it looks roughly like a domain/hostname
  // - No spaces
  // - Only alphanumeric characters, dots, and hyphens
  // - Starts and ends with alphanumeric character
  const domainRegex = /^[a-z0-9]([a-z0-9-\.]*[a-z0-9])?$/;
  if (!domainRegex.test(domain)) {
    return null;
  }

  return domain;
}

/**
 * The current policy schema version. It is exported from the domain module
 * so that the migration chain, the policy store, and the import UI all agree
 * on what "current" means.
 */
export const CURRENT_POLICY_SCHEMA_VERSION = 1 as const;

/**
 * The rule types that are valid in the current schema. A migration that
 * changes a rule's type silently (i.e. without going through an explicit
 * migration step) is rejected.
 */
export const POLICY_RULE_TYPES = ["allow", "deny", "require_approval", "rate_limit"] as const;

export type PolicyRuleType = (typeof POLICY_RULE_TYPES)[number];

export interface PolicyRule {
  id: string;
  type: PolicyRuleType;
  domain: string;
  enabled: boolean;
  [key: string]: unknown;
}

export interface PolicyDocument {
  version: number;
  rules: PolicyRule[];
  [key: string]: unknown;
}

/**
 * Returns true when the given value is a known policy rule type.
 */
export function isPolicyRuleType(value: unknown): value is PolicyRuleType {
  return typeof value === "string" && (POLICY_RULE_TYPES as readonly string[]).includes(value);
}

/**
 * Validates the shape of a single rule. This is used both by the migration
 * chain and the policy store to ensure they agree on what a valid rule is.
 */
export function isValidPolicyRule(value: unknown): value is PolicyRule {
  if (!value || typeof value !== "object") {
    return false;
  }

  const rule = value as Record<string, unknown>;

  if (typeof rule.id !== "string" || !rule.id) {
    return false;
  }

  if (!isPolicyRuleType(rule.type)) {
    return false;
  }

  if (typeof rule.domain !== "string" || !rule.domain) {
    return false;
  }

  if (typeof rule.enabled !== "boolean") {
    return false;
  }

  return true;
}

/**
 * Validates the shape of a policy document at the current schema version.
 */
export function isValidPolicyDocument(value: unknown): value is PolicyDocument {
  if (!value || typeof value !== "object") {
    return false;
  }

  const doc = value as Record<string, unknown>;

  if (doc.version !== CURRENT_POLICY_SCHEMA_VERSION) {
    return false;
  }

  if (!Array.isArray(doc.rules)) {
    return false;
  }

  return doc.rules.every((rule) => isValidPolicyRule(rule));
}
