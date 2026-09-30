import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { DomainError } from "./domain.js";
/** Atomic directory lock with heartbeat; an active owner cannot be adopted as a restart. */
export async function acquireRuntime(state: string) {
  await mkdir(state, { recursive: true, mode: 0o700 });
  try {
    return await lock(state, { lockfilePath: join(state, ".runtime.lock"), realpath: true,
      stale: 10_000, update: 5_000, retries: 0 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new DomainError("RUNTIME_ALREADY_ACTIVE", "Another local server owns this state directory", 503);
    }
    throw e;
  }
}
