export type AuditSeverity = "info" | "low" | "moderate" | "high" | "critical";

export interface AuditExceptionEntry {
  ghsaId: string;
  package: string;
  severity: AuditSeverity | string;
  reason: string;
  updatePath: string;
}

export interface AuditExceptionsConfig {
  severityThreshold?: AuditSeverity | string;
  exceptions?: ReadonlyArray<AuditExceptionEntry>;
}

export interface AuditFinding {
  package: string;
  ghsaId: string;
  severity: string;
  title: string;
  url: string;
}

export interface ExceptedAuditFinding extends AuditFinding {
  reason: string;
  updatePath: string;
}

export interface AuditEvaluationResult {
  ok: boolean;
  threshold: string;
  validationErrors: string[];
  blockingFindings: AuditFinding[];
  exceptedFindings: ExceptedAuditFinding[];
  ignoredBelowThreshold: AuditFinding[];
}

export const SEVERITY_RANK: Readonly<Record<AuditSeverity, number>>;
export const DEFAULT_SEVERITY_THRESHOLD: AuditSeverity;

export function severityMeetsThreshold(
  severity: string,
  threshold?: string,
): boolean;
export function validateAuditExceptions(
  config: unknown,
): string[];
export function evaluateAuditReport(
  auditReport: Record<string, unknown>,
  config?: AuditExceptionsConfig,
): AuditEvaluationResult;
export function runProductionAudit(
  root: string,
  options?: { exceptionsPath?: string; thresholdOverride?: string },
): AuditEvaluationResult;
