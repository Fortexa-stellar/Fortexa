import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

/**
 * Writes a JSON store file atomically.
 *
 * The temp name is unique per write so two processes sharing a store directory
 * cannot clobber each other's staging file: without this, one process can rename
 * the staging file away between another's write and rename, which fails with
 * ENOENT and loses the write.
 */
export async function writeJsonFileAtomic(path: string, value: unknown) {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(tempPath, path);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
