import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fail } from "./errors.mjs";
import { withOwnedFileLock } from "./file-lock.mjs";

const execFileAsync = promisify(execFile);
const SCHEMA = "CODEX_CHAT_TRANSPORT_GATE_V1";
const CLAIM_TTL_MS = 120_000;
const REPROBE_COOLDOWN_MS = 5 * 60_000;
const MAX_RECORD_BYTES = 16 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stable(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseProcessTable(table) {
  const processes = [];
  for (const line of table.split(/\r?\n/u)) {
    const match = line.match(
      /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/u,
    );
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      startedAt: match[2].replace(/\s+/gu, " "),
      executable: match[3],
    });
  }
  return processes;
}

function newestProcess(processes, suffix) {
  return processes
    .filter((entry) => entry.executable.endsWith(suffix))
    .sort((left, right) => (
      Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
      left.pid - right.pid
    ))
    .at(-1) ?? null;
}

async function defaultProcessTable(platform) {
  if (platform !== "darwin") return null;
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", "pid=,lstart=,comm="],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

export async function inspectDesktopGeneration({
  platform = process.platform,
  processTable = () => defaultProcessTable(platform),
} = {}) {
  if (platform !== "darwin") {
    return {
      platform,
      supported: false,
      ready: false,
      reason: "desktop_generation_unsupported",
      app: null,
      host: null,
      generationId: null,
      hostGenerationId: null,
    };
  }

  const table = await processTable();
  if (typeof table !== "string") {
    fail(
      "TRANSPORT_GATE_PROCESS_SNAPSHOT_INVALID",
      "Desktop process snapshot is unavailable.",
    );
  }
  const processes = parseProcessTable(table);
  const app = newestProcess(
    processes,
    "/ChatGPT.app/Contents/MacOS/ChatGPT",
  );
  const host = newestProcess(processes, "/codex-code-mode-host");
  const ready = app !== null && host !== null;
  const generation = { platform, app, host };
  return {
    platform,
    supported: true,
    ready,
    reason: ready ? "desktop_host_ready" : "desktop_host_not_ready",
    app,
    host,
    generationId: ready ? sha256(stable(generation)) : null,
    hostGenerationId: host ? sha256(stable(host)) : null,
  };
}

function pathsFor(transportStateDir) {
  const root = path.resolve(transportStateDir);
  return {
    root,
    record: path.join(root, "gate.json"),
    lock: path.join(root, ".gate.lock"),
  };
}

async function prepareDirectory(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(
      "TRANSPORT_GATE_DIRECTORY_INVALID",
      "Transport gate directory must be a real directory.",
    );
  }
  if ((info.mode & 0o077) !== 0) {
    fail(
      "TRANSPORT_GATE_DIRECTORY_INVALID",
      "Transport gate directory must not be accessible by group or other users.",
    );
  }
  const canonical = await realpath(root);
  return canonical;
}

function validProcess(value) {
  return (
    value &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.startedAt === "string" &&
    value.startedAt.length > 0 &&
    typeof value.executable === "string" &&
    value.executable.startsWith("/")
  );
}

function validateRecord(record) {
  const claimStateValid = record?.status === "half_open"
    ? (
        typeof record.claimToken === "string" &&
        record.claimToken.length > 0 &&
        Number.isSafeInteger(record.claimedAt) &&
        Number.isSafeInteger(record.claimExpiresAt) &&
        record.claimExpiresAt > record.claimedAt
      )
    : (
        record?.claimToken === null &&
        record?.claimedAt === null &&
        record?.claimExpiresAt === null
      );
  const valid = (
    record &&
    record.schema === SCHEMA &&
    ["open", "half_open", "closed", "idle"].includes(record.status) &&
    typeof record.generationId === "string" &&
    /^[a-f0-9]{64}$/u.test(record.generationId) &&
    typeof record.hostGenerationId === "string" &&
    /^[a-f0-9]{64}$/u.test(record.hostGenerationId) &&
    validProcess(record.generation?.app) &&
    validProcess(record.generation?.host) &&
    claimStateValid &&
    (record.lastFailure === null || (
      typeof record.lastFailure?.observedAt === "string" &&
      record.lastFailure?.error === "Transport closed"
    )) &&
    (record.lastSuccessAt === null ||
      typeof record.lastSuccessAt === "string") &&
    (record.status !== "open" || record.lastFailure !== null) &&
    (record.status !== "closed" || record.lastSuccessAt !== null)
  );
  if (!valid) {
    fail(
      "TRANSPORT_GATE_STATE_INVALID",
      "Transport gate state is malformed or unsupported.",
    );
  }
  return record;
}

async function readRecord(filePath) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) {
    fail(
      "TRANSPORT_GATE_STATE_INVALID",
      "Transport gate state must be a bounded regular file.",
    );
  }

  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const descriptorInfo = await handle.stat();
    if (
      !descriptorInfo.isFile() ||
      descriptorInfo.dev !== info.dev ||
      descriptorInfo.ino !== info.ino ||
      descriptorInfo.size > MAX_RECORD_BYTES
    ) {
      fail(
        "TRANSPORT_GATE_STATE_INVALID",
        "Transport gate state changed while it was being read.",
      );
    }
    const bytes = await handle.readFile();
    let record;
    try {
      record = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      fail(
        "TRANSPORT_GATE_STATE_INVALID",
        "Transport gate state is not valid UTF-8 JSON.",
      );
    }
    return validateRecord(record);
  } catch (error) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes(error.code)) {
      fail(
        "TRANSPORT_GATE_STATE_INVALID",
        "Transport gate state changed while it was being read.",
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(filePath, record) {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const contents = `${stable(record)}\n`;
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  try {
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
    const directory = await open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function nowFrom(clock) {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("TRANSPORT_GATE_CLOCK_INVALID", "Transport gate clock is invalid.");
  }
  return value;
}

function generationRecord(generation) {
  return {
    platform: generation.platform,
    app: generation.app,
    host: generation.host,
  };
}

function appChanged(record, generation) {
  return record?.generation?.app?.pid !== generation.app.pid ||
    record?.generation?.app?.startedAt !== generation.app.startedAt;
}

function buildClaimRecord({
  current,
  generation,
  token,
  now,
}) {
  return {
    schema: SCHEMA,
    status: "half_open",
    generation: generationRecord(generation),
    generationId: generation.generationId,
    hostGenerationId: generation.hostGenerationId,
    claimToken: token,
    claimedAt: now.getTime(),
    claimExpiresAt: now.getTime() + CLAIM_TTL_MS,
    lastFailure: current?.lastFailure ?? null,
    lastSuccessAt: current?.lastSuccessAt ?? null,
  };
}

function claimResult({
  probeAllowed,
  reason,
  generation,
  claimToken = null,
  restartVerified = null,
  current = null,
  retryAfter = null,
}) {
  return {
    gateState: probeAllowed ? "half_open" : current?.status ?? "unavailable",
    probeAllowed,
    reason,
    restartVerified,
    claimToken,
    generation,
    previousFailure: current?.lastFailure ?? null,
    retryAfter: probeAllowed
      ? null
      : retryAfter ?? (
          current?.status === "half_open" && current.claimExpiresAt !== null
            ? new Date(current.claimExpiresAt).toISOString()
            : null
        ),
  };
}

export async function transportGate({
  action,
  claimToken = null,
  transportStateDir,
  generationProvider = inspectDesktopGeneration,
  clock = () => new Date(),
  createToken = randomUUID,
}) {
  if (!["claim", "success", "failure", "release"].includes(action)) {
    fail(
      "TRANSPORT_GATE_ACTION_INVALID",
      "Transport gate action must be claim, success, failure, or release.",
    );
  }
  const canonicalRoot = await prepareDirectory(path.resolve(transportStateDir));
  const paths = pathsFor(canonicalRoot);
  return withOwnedFileLock({
    lockPath: paths.lock,
    busyCode: "TRANSPORT_GATE_BUSY",
    busyMessage: "Another coordinator is updating the transport gate.",
  }, async () => {
    const current = await readRecord(paths.record);

    if (action === "release") {
      if (
        current?.status !== "half_open" ||
        typeof claimToken !== "string" ||
        claimToken !== current.claimToken
      ) {
        fail(
          "TRANSPORT_GATE_CLAIM_MISMATCH",
          "Transport gate claim token does not own the active probe.",
        );
      }
      const next = {
        ...current,
        status: "idle",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      };
      await atomicWrite(paths.record, next);
      return {
        gateState: next.status,
        probeAllowed: false,
        reason: "probe_released",
        restartVerified: null,
        claimToken: null,
        generation: {
          ...next.generation,
          supported: true,
          ready: null,
          reason: "claimed_generation_not_reprobed",
          generationId: next.generationId,
          hostGenerationId: next.hostGenerationId,
        },
        previousFailure: next.lastFailure,
        retryAfter: null,
      };
    }

    const generation = await generationProvider();
    if (
      generation?.supported !== true ||
      generation.ready !== true ||
      generation.app === null ||
      generation.host === null
    ) {
      if (action !== "claim") {
        fail(
          "TRANSPORT_GATE_HOST_NOT_READY",
          "The ChatGPT desktop browser host is not ready.",
        );
      }
      return claimResult({
        probeAllowed: false,
        reason: generation?.reason ?? "desktop_host_not_ready",
        generation,
        current,
      });
    }

    if (action === "claim") {
      const now = nowFrom(clock);
      if (
        current?.status === "open" &&
        current.hostGenerationId === generation.hostGenerationId
      ) {
        const failedAt = Date.parse(current.lastFailure.observedAt);
        if (!Number.isFinite(failedAt)) {
          fail(
            "TRANSPORT_GATE_STATE_INVALID",
            "Transport gate failure time is malformed or unsupported.",
          );
        }
        const retryAt = failedAt + REPROBE_COOLDOWN_MS;
        if (now.getTime() < retryAt) {
          return claimResult({
            probeAllowed: false,
            reason: "same_host_cooldown_active",
            restartVerified: false,
            generation,
            current,
            retryAfter: new Date(retryAt).toISOString(),
          });
        }
      }
      if (
        current?.status === "half_open" &&
        current.hostGenerationId === generation.hostGenerationId &&
        current.claimExpiresAt > now.getTime()
      ) {
        return claimResult({
          probeAllowed: false,
          reason: "probe_in_progress",
          restartVerified: false,
          generation,
          current,
        });
      }

      const token = createToken();
      if (
        typeof token !== "string" ||
        token.length < 1 ||
        token.length > 128
      ) {
        fail(
          "TRANSPORT_GATE_TOKEN_INVALID",
          "Transport gate claim token is invalid.",
        );
      }
      const hostChanged = (
        current !== null &&
        current.hostGenerationId !== generation.hostGenerationId
      );
      const sameHostCooldownElapsed = (
        current?.status === "open" &&
        current.hostGenerationId === generation.hostGenerationId
      );
      const reason = hostChanged
        ? "host_generation_changed"
        : sameHostCooldownElapsed
          ? "same_host_cooldown_elapsed"
        : current?.status === "half_open"
          ? "probe_claim_expired"
          : "probe_claimed";
      const next = buildClaimRecord({
        current,
        generation,
        token,
        now,
      });
      await atomicWrite(paths.record, next);
      return claimResult({
        probeAllowed: true,
        reason,
        restartVerified: hostChanged
          ? appChanged(current, generation)
          : sameHostCooldownElapsed
            ? false
          : null,
        generation,
        claimToken: token,
        current: next,
      });
    }

    if (
      current?.status !== "half_open" ||
      typeof claimToken !== "string" ||
      claimToken !== current.claimToken
    ) {
      fail(
        "TRANSPORT_GATE_CLAIM_MISMATCH",
        "Transport gate claim token does not own the active probe.",
      );
    }
    if (current.hostGenerationId !== generation.hostGenerationId) {
      fail(
        "TRANSPORT_GATE_GENERATION_CHANGED",
        "Browser host generation changed during the claimed probe.",
      );
    }

    const now = nowFrom(clock);
    const next = {
      schema: SCHEMA,
      status: action === "success" ? "closed" : "open",
      generation: generationRecord(generation),
      generationId: generation.generationId,
      hostGenerationId: generation.hostGenerationId,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      lastFailure: action === "failure"
        ? {
            observedAt: now.toISOString(),
            error: "Transport closed",
          }
        : current.lastFailure,
      lastSuccessAt: action === "success"
        ? now.toISOString()
        : current.lastSuccessAt,
    };
    await atomicWrite(paths.record, next);
    return {
      gateState: next.status,
      probeAllowed: action === "success",
      reason: action === "success"
        ? "probe_succeeded"
        : "transport_closed_recorded",
      restartVerified: null,
      claimToken: null,
      generation,
      previousFailure: next.lastFailure,
      retryAfter: null,
    };
  });
}
