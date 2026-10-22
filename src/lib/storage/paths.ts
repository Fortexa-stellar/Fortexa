import { promises as fs } from "node:fs";
import path from "node:path";

function resolveFromCwd(value: string) {
  return path.isAbsolute(value) ? value : path.join(process.cwd(), value);
}

export function getFortexaStoreDir() {
  const configured = process.env.FORTEXA_STORE_DIR?.trim();
  if (configured) {
    return resolveFromCwd(configured);
  }

  if (process.env.VERCEL === "1") {
    return path.join("/tmp", "fortexa");
  }

  return path.join(process.cwd(), ".fortexa");
}

export function getFortexaStorePath(fileName: string) {
  return path.join(getFortexaStoreDir(), fileName);
}

export type StoragePathRejectionReason =
  | "empty_path"
  | "parent_traversal"
  | "absolute_path_outside_data_dir"
  | "not_a_file_in_data_dir"
  | "symlink_outside_data_dir";

const REJECTION_DESCRIPTIONS: Record<StoragePathRejectionReason, string> = {
  empty_path: "the path is empty",
  parent_traversal: "the path uses '..' to leave the data directory",
  absolute_path_outside_data_dir: "the absolute path is outside the data directory",
  not_a_file_in_data_dir: "the path does not name a file inside the data directory",
  symlink_outside_data_dir:
    "the path goes through a symlink that resolves outside the data directory",
};

/**
 * Thrown when a storage path would leave the data directory. The message names
 * the configured path and the reason only; nothing is ever read from the
 * rejected location, so file contents cannot end up in the error.
 */
export class StoragePathError extends Error {
  readonly reason: StoragePathRejectionReason;
  readonly requestedPath: string;

  constructor(reason: StoragePathRejectionReason, requestedPath: string) {
    super(
      `Refusing storage path "${requestedPath}": ${REJECTION_DESCRIPTIONS[reason]} (${reason}).`
    );
    this.name = "StoragePathError";
    this.reason = reason;
    this.requestedPath = requestedPath;
  }
}

declare const containedStorePathBrand: unique symbol;

/**
 * An absolute, symlink-resolved path proven to sit inside the data directory.
 * Only resolveContainedStorePath produces one, so a store opener that takes
 * this type cannot be handed an unchecked path.
 */
export type ContainedStorePath = string & { readonly [containedStorePathBrand]: true };

/** True when `child` is `parent` itself or below it, by path segments, not string prefix. */
function isWithin(parent: string, child: string) {
  const relative = path.relative(parent, child);
  if (relative === "") {
    return true;
  }
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}

function isMissing(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Resolves every symlink in `target`, including for a target that does not
 * exist yet: the nearest existing ancestor is resolved and the missing tail
 * re-appended. Returns null when an entry exists but cannot be resolved (a
 * dangling symlink), since writing through it would create its target
 * wherever it points.
 */
async function resolveRealPath(target: string): Promise<string | null> {
  const missingTail: string[] = [];
  let current = target;

  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missingTail);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }

    try {
      await fs.lstat(current);
      return null;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return target;
    }
    missingTail.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * Resolves a storage file path against the data directory and proves it stays
 * inside it: lexically (no `..` or absolute escape) and on disk (no symlink
 * anywhere along the path leads outside). Throws StoragePathError otherwise.
 *
 * Containment is checked by path segments on resolved paths, so a sibling
 * such as `<data>-other/db` is rejected even though it shares a string prefix
 * with `<data>`.
 */
export async function resolveContainedStorePath(
  requestedPath: string,
  dataDirectory: string = getFortexaStoreDir()
): Promise<ContainedStorePath> {
  if (!requestedPath.trim()) {
    throw new StoragePathError("empty_path", requestedPath);
  }

  const dataDir = path.resolve(dataDirectory);
  const candidate = path.resolve(dataDir, requestedPath);

  if (!isWithin(dataDir, candidate)) {
    throw new StoragePathError(
      path.isAbsolute(requestedPath) ? "absolute_path_outside_data_dir" : "parent_traversal",
      requestedPath
    );
  }

  if (candidate === dataDir) {
    throw new StoragePathError("not_a_file_in_data_dir", requestedPath);
  }

  const realDataDir = await resolveRealPath(dataDir);
  const realCandidate = await resolveRealPath(candidate);

  if (
    !realDataDir ||
    !realCandidate ||
    !isWithin(realDataDir, realCandidate) ||
    realCandidate === realDataDir
  ) {
    throw new StoragePathError("symlink_outside_data_dir", requestedPath);
  }

  return realCandidate as ContainedStorePath;
}
