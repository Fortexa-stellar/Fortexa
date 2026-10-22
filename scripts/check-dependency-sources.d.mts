export interface DependencyFinding {
  location: string;
  package: string;
  spec: string;
  rule: string;
  description: string;
}

export interface DependencySourceRule {
  rule: string;
  pattern: RegExp;
  description: string;
}

export interface ScanResult {
  findings: DependencyFinding[];
  clean: boolean;
  error?: Error;
}

export const UNREVIEWED_SOURCE_RULES: DependencySourceRule[];
export function checkDependencySpec(spec: string): DependencySourceRule | null;
export function scanPackageManifest(pkg: any): DependencyFinding[];
export function scanPackageLock(lock: any): DependencyFinding[];
export function scanRepositoryDependencySources(rootDir?: string): ScanResult;
export function main(): void;
