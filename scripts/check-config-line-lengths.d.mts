export interface LineLengthViolation {
  file: string;
  line: number;
  length: number;
}

export const MAX_LINE_LENGTH: number;
export function isIgnoredPath(path: string): boolean;
export function isScannedConfigFile(path: string): boolean;
export function findOversizedLines(
  content: string,
  maxLength?: number,
): { line: number; length: number }[];
export function findConfigFiles(root: string): string[];
export function checkFiles(
  root: string,
  files: string[],
  maxLength?: number,
): LineLengthViolation[];
export function checkRoot(
  root: string,
  maxLength?: number,
): { files: string[]; violations: LineLengthViolation[] };
export function formatViolation(violation: Pick<LineLengthViolation, "file" | "line">): string;
