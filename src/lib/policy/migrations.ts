import { normalizePolicy } from "@/lib/policy/normalize";
import { z } from "zod";

import { defaultPolicyConfig } from "@/lib/policy/engine";
import type { PolicyConfig } from "@/lib/types/domain";
import { policyConfigSchema } from "@/lib/validation/schemas";

/**
 * Policy migration chain.
 *
 * Goals:
 * - Verify that representative historical policy payloads still load after
 *   schema changes.
 * - Either accept them, migrate them via an explicit narrow set of
 *   documented default-fill steps, or reject them with a structured error
 *   an operator can act on.
 *
 * Behavior:
 * 1. Resolve the document's declared schema version. Unknown or future
 *    versions are rejected outright so a newer document cannot silently
 *    downgrade onto an older schema.
 * 2. Strict-parse the candidate against `policyConfigSchema`.
 * 3. If strict-parse fails and the only issues are missing documented
 *    optional fields (those with a safe default in `OPTIONAL_DEFAULTS`),
 *    fill them with the documented default and re-parse.
 * 4. Verify that the migration did not silently change a rule type: every
 *    field that was present in the raw document must still have the same
 *    JS kind after migration.
 * 5. If re-parse still fails, or if any non-optional / type-related issue
 *    is present, return a `{ ok: false, error, issues }` result describing
 *    every Zod issue.
 *
 * Guardrails:
 * - This helper is pure: it does not read or write `.fortexa/` policy
 *   files. Calls decide what to persist.
 * - It does not weaken `policyConfigSchema`. Migration only fills fields
 *   that are explicitly listed in `OPTIONAL_DEFAULTS`. Wrong-type or
 *   otherwise invalid values always surface as errors.
 *
 * Future schema changes: when adding a new optional field with a safe
 * default, register it in `OPTIONAL_DEFAULTS` and add a fixture under
 * `__fixtures__/` that exercises the unmigrated shape. Add a test asserting
 * that `parseStoredPolicy` migrates it cleanly.
 */

/**
 * The current policy schema version. Bump this whenever the shape of
 * PolicyConfig changes in a way that requires a migration step.
 */
export const CURRENT_POLICY_SCHEMA_VERSION = 1 as const;

/**
 * Versions this migration chain knows how to read. A document that
 * declares a version outside this set is rejected rather than being
 * silently coerced onto the current shape.
 */
export const KNOWN_POLICY_SCHEMA_VERSIONS = [1] as const;

export type PolicyMigration = {
  field: string;
  reason: "missing-optional-default";
  filledFrom: "defaultPolicyConfig";
};

export type PolicyParseSuccess = {
  ok: true;
  policy: PolicyConfig;
  migrations: PolicyMigration[];
  version: number;
};

export type PolicyParseFailure = {
  ok: false;
  error: string;
  issues: { path: string; message: string }[];
  /** The version that failed to migrate, when known. */
  version?: number | null;
};

export type PolicyParseResult = PolicyParseSuccess | PolicyParseFailure;

/**
 * Documented optional fields with safe defaults.
 *
 * Each entry must be safe to fill silently when an older stored payload
 * predates the field's introduction. Do not add fields whose absence is
 * potentially intentional or whose default could mask unsafe operator
 * intent — those belong as required fields with strict validation.
 */
const OPTIONAL_DEFAULTS: Record<string, unknown> = {
  allowedHours: defaultPolicyConfig.allowedHours,
};

/**
 * The field name that carries the schema version in an imported document.
 * It is stripped before the document is validated against the policy
 * schema, so it never becomes part of the persisted policy.
 */
const VERSION_FIELD = "schemaVersion";

function formatFailure(error: z.ZodError, version?: number | null): PolicyParseFailure {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "<root>",
    message: issue.message,
  }));

  const summary = issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");

  return {
    ok: false,
    error: `Stored policy payload is malformed. ${summary}`,
    issues,
    version: version ?? null,
  };
}

function failure(error: string, version?: number | null): PolicyParseFailure {
  return {
    ok: false,
    error,
    issues: [],
    version: version ?? null,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve the declared schema version from a raw document. Documents
 * that do not declare a version are treated as version 1 (legacy
 * payloads predate the version field).
 */
function resolveDeclaredVersion(raw: Record<string, unknown>): number | null {
  const declared = raw[VERSION_FIELD];
  if (declared === undefined) {
    return 1;
  }
  if (typeof declared !== "number" || !Number.isInteger(declared)) {
    return null;
  }
  return declared;
}

function stripVersionField(raw: Record<string, unknown>): Record<string, unknown> {
  const { [VERSION_FIELD]: _,
  ...rest } = raw;
  return rest;
}

/**
 * JS kind of a value, used to detect silent rule-type changes during
 * migration. Null and array are distinguished from `object` so a field
 * that flips from a scalar to a collection (or vice versa) is caught.
 */
function jsKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Detect fields whose JS kind changed between the raw document and the
 * migrated/parsed output. This guards against a migration that
 * silently rewrites a rule from one type to another (e.g. a scalar cap
 * becoming an array), which would change live payment decisions.
 */
function findTypeChanges(
  raw: Record<string, unknown>,
  parsed: Record<string, unknown>,
): { path: string; message: string }[] {
  const changes: { path: string; message: string }[] = [];

  for (const key of Object.keys(raw)) {
    if (!(key in parsed)) continue;
    const before = jsKind(raw[key]);
    const after = jsKind(parsed[key]);
    if (before !== after) {
      changes.push({
        path: key,
        message: `migration changed rule type from ${before} to ${after}`,
      });
    }
  }

  return changes;
}

/**
 * Decide whether every top-level failing path is a documented optional
 * field that is entirely missing from the raw input. Returns the list of
 * fields we can migrate, or `null` when any issue is non-migratable.
 */
function findMigratableFields(
  raw: Record<string, unknown>,
  paths: Set<string>,
): string[] | null {
  const fields: string[] = [];

  for (const path of paths) {
    if (!(path in OPTIONAL_DEFAULTS) || path in raw) {
      return null;
    }
    fields.push(path);
  }

  return fields.length > 0 ? fields : null;
}

export function parseStoredPolicy(raw: unknown): PolicyParseResult {
  if (!isPlainObject(raw)) {
    const strict = policyConfigSchema.safeParse(raw);
    if (strict.success) {
      return {
        ok: true,
        policy: strict.data,
        migrations: [],
        version: CURRENT_POLICY_SCHEMA_VERSION,
      };
    }
    return formatFailure(strict.error, null);
  }

  // Reject unknown / future versions before attempting any migration.
  const declaredVersion = resolveDeclaredVersion(raw);
  if (declaredVersion === null) {
    return failure(
      `Policy document declares an invalid ${VERSION_FIELD}; expected an integer.`,
      null,
    );
  }

  if (!(KNOWN_POLICY_SCHEMA_VERSIONS as readonly number[]).includes(declaredVersion)) {
    return failure(
      `Unknown policy schema version ${declaredVersion}. Supported versions: ${KNOWN_POLICY_SCHEMA_VERSIONS.join(", ")}.`,
      declaredVersion,
    );
  }

  const stripped = stripVersionField(raw);

  const strict = policyConfigSchema.safeParse(stripped);
  if (strict.success) {
    return {
      ok: true,
      policy: strict.data,
      migrations: [],
      version: declaredVersion,
    };
  }

  const issuePaths = new Set(
    strict.error.issues.map((issue) => {
      const head = issue.path[0];
      return head === undefined ? "" : String(head);
    }),
  );

  const migratableFields = findMigratableFields(stripped, issuePaths);
  if (!migratableFields) {
    return formatFailure(strict.error, declaredVersion);
  }

  const attempted: Record<string, unknown> = { ...stripped };
  const migrations: PolicyMigration[] = [];

  for (const field of migratableFields) {
    attempted[field] = OPTIONAL_DEFAULTS[field];
    migrations.push({
      field,
      reason: "missing-optional-default",
      filledFrom: "defaultPolicyConfig",
    });
  }

  const migrated = policyConfigSchema.safeParse(attempted);
  if (!migrated.success) {
    return formatFailure(migrated.error, declaredVersion);
  }

  // Guard against a migration that silently changed a rule type.
  const typeChanges = findTypeChanges(
    stripped,
    migrated.data as unknown as Record<string, unknown>,
  );
  if (typeChanges.length > 0) {
    const summary = typeChanges
      .map((change) => `${change.path}: ${change.message}`)
      .join("; ");
    return {
      ok: false,
      error: `Policy migration changed a rule type. ${summary}`,
      issues: typeChanges,
      version: declaredVersion,
    };
  }

  return {
    ok: true,
    policy: migrated.data,
    migrations,
    version: declaredVersion,
  };
}


export function migratePolicy(raw: unknown):
  | { ok: true; policy: PolicyConfig }
  | { ok: false; failedVersion?: number | null; error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, failedVersion: null, error: "Invalid policy object" };
  }

  const rawObj = raw as Record<string, unknown>;
  const version = rawObj.schemaVersion ?? rawObj.version ?? 0;

  if (typeof version === "number" && version > CURRENT_POLICY_SCHEMA_VERSION) {
    return { ok: false, failedVersion: version, error: `Unknown version ${version}` };
  }

  if ("allowedDomains" in rawObj && !Array.isArray(rawObj.allowedDomains)) {
    return { ok: false, failedVersion: typeof version === "number" ? version : null, error: "allowedDomains must be an array" };
  }
  if ("blockedDomains" in rawObj && !Array.isArray(rawObj.blockedDomains)) {
    return { ok: false, failedVersion: typeof version === "number" ? version : null, error: "blockedDomains must be an array" };
  }
  if ("allowedTools" in rawObj && !Array.isArray(rawObj.allowedTools)) {
    return { ok: false, failedVersion: typeof version === "number" ? version : null, error: "allowedTools must be an array" };
  }
  if ("blockedTools" in rawObj && !Array.isArray(rawObj.blockedTools)) {
    return { ok: false, failedVersion: typeof version === "number" ? version : null, error: "blockedTools must be an array" };
  }
  if ("perTxCapXLM" in rawObj && typeof rawObj.perTxCapXLM !== "number") {
    return { ok: false, failedVersion: typeof version === "number" ? version : null, error: "perTxCapXLM must be a number" };
  }
  if ("dailyCapXLM" in rawObj && typeof rawObj.dailyCapXLM !== "number") {
    return { ok: false, failedVersion: typeof version === "number" ? version : null, error: "dailyCapXLM must be a number" };
  }
  if ("maxToolCallsPerDay" in rawObj && typeof rawObj.maxToolCallsPerDay !== "number") {
    return { ok: false, failedVersion: typeof version === "number" ? version : null, error: "maxToolCallsPerDay must be a number" };
  }
  if ("riskThreshold" in rawObj && typeof rawObj.riskThreshold !== "number") {
    return { ok: false, failedVersion: typeof version === "number" ? version : null, error: "riskThreshold must be a number" };
  }
  if ("allowedHours" in rawObj && (typeof rawObj.allowedHours !== "object" || rawObj.allowedHours === null || Array.isArray(rawObj.allowedHours))) {
    return { ok: false, failedVersion: typeof version === "number" ? version : null, error: "allowedHours must be an object" };
  }

  const normalized = normalizePolicy(rawObj as Partial<PolicyConfig>);
  return { ok: true, policy: normalized };
}
