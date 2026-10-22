export interface AuditException {
  package: string;
  severity?: string;
  advisory?: string;
  reason: string;
  updatePath: string;
}

export interface AuditPolicy {
  severityThreshold: string;
  exceptions: AuditException[];
}

export interface AuditFinding {
  package: string;
  severity: string;
  title: string;
  fixAvailable: unknown;
}

export interface ExemptedVulnerability {
  package: string;
  severity: string;
  reason: string;
  updatePath: string;
}

export interface EvaluationResult {
  passed: boolean;
  findings: AuditFinding[];
  exempted: ExemptedVulnerability[];
  stats: Record<string, number>;
}

export const SEVERITY_LEVELS: Record<string, number>;
export function loadPolicy(configPath?: string): AuditPolicy;
export function evaluateVulnerabilities(auditData: any, policy: AuditPolicy): EvaluationResult;
export function runProductionAudit(options?: { configPath?: string; policy?: AuditPolicy }): number;
