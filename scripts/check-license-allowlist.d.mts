export interface PackageInfo {
  path: string;
  name: string;
  version?: string;
  license: string;
}

export interface LicenseViolation {
  path: string;
  name: string;
  version?: string;
  license: string;
  reason: string;
}

export interface LicensePolicy {
  allowedLicenses: string[];
  disallowedLicenses: string[];
  packageOverrides?: Record<string, string>;
}

export interface LicenseAuditResult {
  packages: PackageInfo[];
  licenseCounts: Record<string, number>;
  violations: LicenseViolation[];
  clean: boolean;
}

export function normalizeLicense(rawLicense: unknown): string;
export function loadLicensePolicy(configPath?: string): LicensePolicy;
export function auditDependencyLicenses(lock: unknown, policy: LicensePolicy): LicenseAuditResult;
export function runLicenseCheck(options?: { rootDir?: string; configPath?: string }): number;
