import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fail } from "./errors.mjs";

const LOCK_WAIT_MS = 5_000;
const MIN_RETRY_MS = 5;
const MAX_RETRY_MS = 50;

function retryDelay(attempt) {
  return Math.min(MAX_RETRY_MS, MIN_RETRY_MS * (2 ** Math.min(attempt, 4)));
}

async function waitForRetry(attempt) {
  await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
}

async function acquireRecoveryLock(recoveryLockPath) {
  const deadline = performance.now() + LOCK_WAIT_MS;
  for (let attempt = 0; performance.now() < deadline; attempt += 1) {
    try {
      const handle = await open(recoveryLockPath, "wx", 0o600);
      const metadata = JSON.stringify({
        pid: process.pid,
        token: randomUUID(),
        createdAt: new Date().toISOString(),
      });
      try {
        await handle.writeFile(metadata);
        await handle.sync();
        return handle;
      } catch (error) {
        await handle.close();
        await rm(recoveryLockPath, { force: true });
        throw error;
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await waitForRetry(attempt);
    }
  }
  fail(
    "LOCK_RECOVERY_BUSY",
    "Lock recovery is busy or requires explicit repair after a recovery-writer crash.",
  );
}

async function withRecoveryLock(recoveryLockPath, operation) {
  const recovery = await acquireRecoveryLock(recoveryLockPath);
  try {
    return await operation();
  } finally {
    await recovery.close();
    await rm(recoveryLockPath, { force: true });
  }
}

async function removeOwnedLock(lockPath, recoveryLockPath, expectedMetadata) {
  return withRecoveryLock(recoveryLockPath, async () => {
    const current = await readFile(lockPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current === expectedMetadata) {
      await rm(lockPath);
      return true;
    }
    return false;
  });
}

function lockOwnerIsProvenDead(contents) {
  let metadata;
  try {
    metadata = JSON.parse(contents);
  } catch {
    return false;
  }
  if (!Number.isInteger(metadata.pid) || typeof metadata.token !== "string") {
    return false;
  }
  try {
    process.kill(metadata.pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

async function acquireLock({ lockPath, recoveryLockPath, busyCode, busyMessage }) {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = performance.now() + LOCK_WAIT_MS;
  for (let attempt = 0; performance.now() < deadline; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const metadata = JSON.stringify({
        pid: process.pid,
        token: randomUUID(),
        createdAt: new Date().toISOString(),
      });
      try {
        await handle.writeFile(metadata);
        await handle.sync();
        return { handle, metadata };
      } catch (error) {
        await handle.close();
        await removeOwnedLock(lockPath, recoveryLockPath, metadata);
        throw error;
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const observed = await readFile(lockPath, "utf8").catch((readError) => {
        if (readError.code === "ENOENT") return null;
        throw readError;
      });
      if (observed === null) continue;
      if (!lockOwnerIsProvenDead(observed)) {
        await waitForRetry(attempt);
        continue;
      }
      let reclaimed = false;
      try {
        reclaimed = await withRecoveryLock(recoveryLockPath, async () => {
          const current = await readFile(lockPath, "utf8").catch((readError) => {
            if (readError.code === "ENOENT") return null;
            throw readError;
          });
          if (
            current !== observed ||
            current === null ||
            !lockOwnerIsProvenDead(current)
          ) {
            return current === null;
          }
          await rm(lockPath);
          return true;
        });
      } catch (recoveryError) {
        if (recoveryError.code !== "LOCK_RECOVERY_BUSY") throw recoveryError;
      }
      if (reclaimed) continue;
      await waitForRetry(attempt);
    }
  }
  fail(busyCode, busyMessage);
}

export async function withOwnedFileLock({
  lockPath,
  busyCode = "RESOURCE_BUSY",
  busyMessage = "Another writer holds the resource lock.",
}, operation) {
  const absoluteLock = path.resolve(lockPath);
  const recoveryLockPath = `${absoluteLock}.recovery`;
  const lock = await acquireLock({
    lockPath: absoluteLock,
    recoveryLockPath,
    busyCode,
    busyMessage,
  });
  try {
    return await operation();
  } finally {
    await lock.handle.close();
    await removeOwnedLock(absoluteLock, recoveryLockPath, lock.metadata);
  }
}
