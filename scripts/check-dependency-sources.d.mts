export type DependencySourceRule =
  | "git-source"
  | "github-shorthand"
  | "file-source"
  | "link-source";

export interface ReviewedDependencySource {
  name: string;
  source: string;
  reason?: string;
}

export interface DependencySourceFinding {
  file: string;
  location: string;
  package: string;
  source: string;
  rule: DependencySourceRule;
}

export interface CheckDependencyOptions {
  allowlist?: ReadonlyArray<ReviewedDependencySource>;
}

export const REVIEWED_DEPENDENCY_SOURCES: ReadonlyArray<ReviewedDependencySource>;
export function classifyDependencySource(
  rawSpecifier: string,
): DependencySourceRule | null;
export function checkPackageManifest(
  manifest: Record<string, unknown>,
  filePath?: string,
  options?: CheckDependencyOptions,
): DependencySourceFinding[];
export function checkPackageLock(
  lockfile: Record<string, unknown>,
  filePath?: string,
  options?: CheckDependencyOptions,
): DependencySourceFinding[];
export function scanDependencyFiles(
  root: string,
  options?: CheckDependencyOptions,
): DependencySourceFinding[];
export function formatDependencyFinding(finding: DependencySourceFinding): string;
