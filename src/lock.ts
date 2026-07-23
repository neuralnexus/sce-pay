import { open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

import { ScePayError } from "./errors.js";

type LockOwner = {
  pid: number;
  createdAt: string;
};

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    const candidate = JSON.parse(await readFile(path, "utf8")) as Partial<LockOwner>;
    return typeof candidate.pid === "number" && typeof candidate.createdAt === "string"
      ? { pid: candidate.pid, createdAt: candidate.createdAt }
      : null;
  } catch {
    return null;
  }
}

export async function acquireRunLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      await handle.close();

      let released = false;
      return async () => {
        if (released) {
          return;
        }
        released = true;
        await unlink(path).catch((error: unknown) => {
          if (!hasErrorCode(error, "ENOENT")) {
            throw error;
          }
        });
      };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }

      const owner = await readOwner(path);
      if (owner !== null && processIsAlive(owner.pid)) {
        throw new ScePayError(
          "LOCKED",
          `Another sce-pay process is running (PID ${owner.pid}, since ${owner.createdAt}).`,
        );
      }

      await unlink(path).catch(() => undefined);
    }
  }

  throw new ScePayError("LOCKED", "Could not acquire the sce-pay run lock.");
}
