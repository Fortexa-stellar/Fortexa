import { promises as fs, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendAuditEntry, listAuditEntries, openAuditFileStore } from "@/lib/storage/audit-store";
import { StoragePathError, resolveContainedStorePath } from "@/lib/storage/paths";
import type { AuditEntry } from "@/lib/types/domain";

// Everything lives in a per-test temp directory:
//   <root>/audit          the configured data directory (FORTEXA_STORE_DIR)
//   <root>/audit-other    a sibling that shares the data dir's string prefix
//   <root>/outside        a directory outside the data dir with a secret file

const SECRET = "OUTSIDE-SECRET-CONTENTS-DO-NOT-LEAK";

let root: string;
let dataDir: string;
let outsideDir: string;
let savedStoreDir: string | undefined;
let savedDatabaseUrl: string | undefined;

// Directory links: a junction on Windows (no admin rights needed), a plain
// directory symlink elsewhere. Both are resolved by realpath.
async function linkDirectory(target: string, link: string) {
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

async function expectRejected(promise: Promise<unknown>, reason: StoragePathError["reason"]) {
  const error = await promise.then(
    () => {
      throw new Error("expected the storage path to be rejected");
    },
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(StoragePathError);
  expect((error as StoragePathError).reason).toBe(reason);
  expect((error as Error).message).toContain(reason);
  expect((error as Error).message).not.toContain(SECRET);
  return error as StoragePathError;
}

function auditEntry(id: string): AuditEntry {
  return {
    id,
    timestamp: new Date().toISOString(),
    action: { id: `action-${id}`, domain: "api.example.com" },
    decision: "APPROVE",
  } as unknown as AuditEntry;
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "fortexa-paths-")));
  dataDir = path.join(root, "audit");
  outsideDir = path.join(root, "outside");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.mkdir(path.join(root, "audit-other"), { recursive: true });
  await fs.writeFile(path.join(outsideDir, "audit.json"), SECRET, "utf8");

  savedStoreDir = process.env.FORTEXA_STORE_DIR;
  savedDatabaseUrl = process.env.DATABASE_URL;
  process.env.FORTEXA_STORE_DIR = dataDir;
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  if (savedStoreDir === undefined) delete process.env.FORTEXA_STORE_DIR;
  else process.env.FORTEXA_STORE_DIR = savedStoreDir;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  rmSync(root, { recursive: true, force: true });
});

describe("resolveContainedStorePath", () => {
  it("resolves a file inside the data directory, including nested and not-yet-existing ones", async () => {
    await expect(resolveContainedStorePath("audit.json")).resolves.toBe(
      path.join(dataDir, "audit.json")
    );
    await expect(resolveContainedStorePath("nested/deeper/audit.json")).resolves.toBe(
      path.join(dataDir, "nested", "deeper", "audit.json")
    );
    // `..` that stays inside is fine; containment is judged on the result.
    await expect(resolveContainedStorePath("nested/../audit.json")).resolves.toBe(
      path.join(dataDir, "audit.json")
    );
    // A file whose name merely starts with ".." is not traversal.
    await expect(resolveContainedStorePath("..audit.json")).resolves.toBe(
      path.join(dataDir, "..audit.json")
    );
  });

  it("accepts an absolute path that is inside the data directory", async () => {
    await expect(resolveContainedStorePath(path.join(dataDir, "audit.json"))).resolves.toBe(
      path.join(dataDir, "audit.json")
    );
  });

  it("rejects '..' traversal out of the data directory", async () => {
    await expectRejected(resolveContainedStorePath("../outside/audit.json"), "parent_traversal");
    await expectRejected(
      resolveContainedStorePath("nested/../../outside/audit.json"),
      "parent_traversal"
    );
  });

  it("rejects a sibling directory that only shares the data directory's string prefix", async () => {
    // `<root>/audit-other/db` starts with the string `<root>/audit`.
    expect(path.join(root, "audit-other", "db").startsWith(dataDir)).toBe(true);

    await expectRejected(resolveContainedStorePath("../audit-other/db"), "parent_traversal");
    await expectRejected(
      resolveContainedStorePath(path.join(root, "audit-other", "db")),
      "absolute_path_outside_data_dir"
    );
  });

  it("rejects an absolute path outside the data directory", async () => {
    await expectRejected(
      resolveContainedStorePath(path.join(outsideDir, "audit.json")),
      "absolute_path_outside_data_dir"
    );
  });

  it("rejects the data directory itself and an empty path", async () => {
    await expectRejected(resolveContainedStorePath("."), "not_a_file_in_data_dir");
    await expectRejected(resolveContainedStorePath("   "), "empty_path");
  });

  it("rejects a path through a directory symlink inside the data directory that points outside", async () => {
    await linkDirectory(outsideDir, path.join(dataDir, "linked"));

    // Lexically this is inside the data directory; only the symlink escapes.
    await expectRejected(
      resolveContainedStorePath("linked/audit.json"),
      "symlink_outside_data_dir"
    );
    // Also for a file that does not exist yet behind the link.
    await expectRejected(resolveContainedStorePath("linked/new.json"), "symlink_outside_data_dir");
  });

  it("accepts a directory symlink that stays inside the data directory", async () => {
    await fs.mkdir(path.join(dataDir, "real"), { recursive: true });
    await linkDirectory(path.join(dataDir, "real"), path.join(dataDir, "alias"));

    await expect(resolveContainedStorePath("alias/audit.json")).resolves.toBe(
      path.join(dataDir, "real", "audit.json")
    );
  });

  it("follows a data directory that is itself a symlink", async () => {
    const linkedDataDir = path.join(root, "data-link");
    await linkDirectory(dataDir, linkedDataDir);

    await expect(resolveContainedStorePath("audit.json", linkedDataDir)).resolves.toBe(
      path.join(dataDir, "audit.json")
    );
    await expectRejected(
      resolveContainedStorePath("../outside/audit.json", linkedDataDir),
      "parent_traversal"
    );
  });

  it("rejects a file symlink pointing outside, and a dangling one", async (context) => {
    try {
      await fs.symlink(
        path.join(outsideDir, "audit.json"),
        path.join(dataDir, "audit.json"),
        "file"
      );
      await fs.symlink(
        path.join(outsideDir, "missing.json"),
        path.join(dataDir, "dangling.json"),
        "file"
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        // Windows without Developer Mode cannot create file symlinks. The
        // directory-link tests above cover the same resolution path.
        context.skip();
      }
      throw error;
    }

    await expectRejected(resolveContainedStorePath("audit.json"), "symlink_outside_data_dir");
    await expectRejected(resolveContainedStorePath("dangling.json"), "symlink_outside_data_dir");
    await expect(fs.access(path.join(outsideDir, "missing.json"))).rejects.toThrow();
  });
});

describe("audit file store opener", () => {
  it("opens and uses a store inside the data directory", async () => {
    const opened = await openAuditFileStore();
    expect(opened).toBe(path.join(dataDir, "audit.json"));

    await appendAuditEntry("user-1", auditEntry("entry-1"));
    const entries = await listAuditEntries("user-1");
    expect(entries.map((entry) => entry.id)).toEqual(["entry-1"]);
    expect(await fs.readFile(opened, "utf8")).toContain("entry-1");
  });

  it("refuses to open a '..' path and never creates the outside file", async () => {
    const error = await expectRejected(
      openAuditFileStore("../outside/escaped.json"),
      "parent_traversal"
    );

    expect(error.requestedPath).toBe("../outside/escaped.json");
    await expect(fs.access(path.join(outsideDir, "escaped.json"))).rejects.toThrow();
  });

  it("refuses to open an absolute path outside the data directory and leaves it untouched", async () => {
    await expectRejected(
      openAuditFileStore(path.join(outsideDir, "audit.json")),
      "absolute_path_outside_data_dir"
    );
    expect(await fs.readFile(path.join(outsideDir, "audit.json"), "utf8")).toBe(SECRET);
  });

  it("refuses to open through a symlink out of the data directory without exposing the target contents", async () => {
    await linkDirectory(outsideDir, path.join(dataDir, "linked"));

    await expectRejected(openAuditFileStore("linked/audit.json"), "symlink_outside_data_dir");
    expect(await fs.readFile(path.join(outsideDir, "audit.json"), "utf8")).toBe(SECRET);
  });

  it("refuses reads and writes when the configured data directory contains an escaping audit.json", async (context) => {
    try {
      await fs.symlink(
        path.join(outsideDir, "audit.json"),
        path.join(dataDir, "audit.json"),
        "file"
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip();
      }
      throw error;
    }

    await expectRejected(listAuditEntries("user-1"), "symlink_outside_data_dir");
    await expectRejected(
      appendAuditEntry("user-1", auditEntry("entry-2")),
      "symlink_outside_data_dir"
    );
    // The outside file was neither parsed into an error nor overwritten.
    expect(await fs.readFile(path.join(outsideDir, "audit.json"), "utf8")).toBe(SECRET);
  });
});
