import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
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
import { fail } from "./errors.mjs";
import { withOwnedFileLock } from "./file-lock.mjs";
import { LIMITS_EGO_BOOTSTRAP_V1 } from "./limits.mjs";

const SCHEMA = "CODEX_CHAT_EGO_BOOTSTRAP_LEASE_V1";
const PROTOCOL_VERSION = 1;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_RELEASE_RECEIPTS = 16;
const {
  defaultTtlMs: DEFAULT_TTL_MS,
  minTtlMs: MIN_TTL_MS,
  maxTtlMs: MAX_TTL_MS,
} = LIMITS_EGO_BOOTSTRAP_V1.lease;
const DESCRIPTOR = Object.freeze({
  providerNamespace: "chatgpt.com",
  profileNamespace: "ego-default",
  transportKind: "ego-browser",
});
const OWNER_KEYS = Object.freeze([
  "workspaceId",
  "coordinatorId",
  "workUnitId",
  "agentId",
  "attemptId",
]);

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

function same(left, right) {
  return stable(left) === stable(right);
}

function validIdentifier(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function ownerIsValid(owner) {
  return !(
    !owner ||
    typeof owner !== "object" ||
    Array.isArray(owner) ||
    Object.keys(owner).length !== OWNER_KEYS.length ||
    OWNER_KEYS.some((key) => !validIdentifier(owner[key])) ||
    Object.keys(owner).some((key) => !OWNER_KEYS.includes(key))
  );
}

function validateOwner(owner) {
  if (!ownerIsValid(owner)) {
    fail(
      "EGO_BOOTSTRAP_LEASE_OWNER_INVALID",
      "Ego bootstrap lease owner identity is invalid.",
    );
  }
  return Object.fromEntries(OWNER_KEYS.map((key) => [key, owner[key]]));
}

function validateTtl(ttlMs) {
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < MIN_TTL_MS ||
    ttlMs > MAX_TTL_MS
  ) {
    fail(
      "EGO_BOOTSTRAP_LEASE_TTL_INVALID",
      `Ego bootstrap lease ttlMs must be between ${MIN_TTL_MS} and ${MAX_TTL_MS}.`,
    );
  }
  return ttlMs;
}

function nowFrom(clock) {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(
      "EGO_BOOTSTRAP_LEASE_CLOCK_INVALID",
      "Ego bootstrap lease clock is invalid.",
    );
  }
  return value;
}

function validateLeaseId(value, label = "leaseId") {
  if (!validIdentifier(value)) {
    fail(
      "EGO_BOOTSTRAP_LEASE_ID_INVALID",
      `Ego bootstrap lease ${label} is invalid.`,
    );
  }
  return value;
}

function validateLeaseToken(value) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(
      "EGO_BOOTSTRAP_LEASE_TOKEN_INVALID",
      "Ego bootstrap lease token is invalid.",
    );
  }
  return value;
}

function tokenMatches(token, digest) {
  const actual = Buffer.from(sha256(token), "hex");
  const expected = Buffer.from(digest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function egoBootstrapLeasePaths(transportStateDir) {
  const root = path.resolve(transportStateDir);
  return {
    root,
    record: path.join(root, "ego-bootstrap-lease.json"),
    lock: path.join(root, ".ego-bootstrap-lease.lock"),
  };
}

async function prepareDirectory(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0
  ) {
    fail(
      "EGO_BOOTSTRAP_LEASE_DIRECTORY_INVALID",
      "Ego bootstrap lease directory must be a private real directory.",
    );
  }
  return realpath(root);
}

function validReleaseReceipt(value) {
  const acquiredAt = Date.parse(value?.acquiredAt);
  const releasedAt = Date.parse(value?.releasedAt);
  const expiresAt = Date.parse(value?.expiresAt);
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 7 &&
    [
      "leaseId",
      "owner",
      "tokenSha256",
      "generation",
      "acquiredAt",
      "releasedAt",
      "expiresAt",
    ].every((key) => Object.hasOwn(value, key)) &&
    validIdentifier(value.leaseId) &&
    ownerIsValid(value.owner) &&
    /^[a-f0-9]{64}$/u.test(value.tokenSha256 ?? "") &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    [value.acquiredAt, value.releasedAt, value.expiresAt]
      .every((date) => typeof date === "string" && Number.isFinite(Date.parse(date))) &&
    releasedAt >= acquiredAt &&
    expiresAt > acquiredAt;
}

function validateRecord(value) {
  const allowedKeys = new Set([
    "schema",
    "protocolVersion",
    "descriptor",
    "status",
    "leaseId",
    "owner",
    "generation",
    "tokenSha256",
    "acquiredAt",
    "updatedAt",
    "expiresAt",
    "releaseReceipts",
    "leaseDigest",
  ]);
  const releaseReceipts = value?.releaseReceipts ?? [];
  const { leaseDigest, ...unsigned } = value ?? {};
  const activeTokenValid = value?.status === "active"
    ? typeof value.tokenSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(value.tokenSha256)
    : value?.status === "released" && value.tokenSha256 === null;
  if (
    !value ||
    value.schema !== SCHEMA ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    !Array.isArray(releaseReceipts) ||
    releaseReceipts.length > MAX_RELEASE_RECEIPTS ||
    !releaseReceipts.every(validReleaseReceipt) ||
    !same(value.descriptor, DESCRIPTOR) ||
    !["active", "released"].includes(value.status) ||
    !validIdentifier(value.leaseId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !activeTokenValid ||
    typeof value.acquiredAt !== "string" ||
    Number.isNaN(Date.parse(value.acquiredAt)) ||
    typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.updatedAt)) ||
    typeof value.expiresAt !== "string" ||
    Number.isNaN(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= Date.parse(value.acquiredAt) ||
    !/^[a-f0-9]{64}$/u.test(leaseDigest ?? "") ||
    sha256(stable(unsigned)) !== leaseDigest ||
    !ownerIsValid(value.owner)
  ) {
    fail(
      "EGO_BOOTSTRAP_LEASE_STATE_INVALID",
      "Ego bootstrap lease state is malformed or unsupported.",
    );
  }
  return { ...value, releaseReceipts };
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
      "EGO_BOOTSTRAP_LEASE_STATE_INVALID",
      "Ego bootstrap lease state must be a bounded regular file.",
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
        "EGO_BOOTSTRAP_LEASE_STATE_INVALID",
        "Ego bootstrap lease state changed while it was read.",
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
        "EGO_BOOTSTRAP_LEASE_STATE_INVALID",
        "Ego bootstrap lease state is not valid UTF-8 JSON.",
      );
    }
    return validateRecord(record);
  } catch (error) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes(error.code)) {
      fail(
        "EGO_BOOTSTRAP_LEASE_STATE_INVALID",
        "Ego bootstrap lease state changed while it was read.",
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(filePath, record) {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${stable(record)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
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

function buildRecord({
  status,
  leaseId,
  owner,
  generation,
  tokenSha256,
  acquiredAt,
  updatedAt,
  expiresAt,
  releaseReceipts = [],
}) {
  const body = {
    schema: SCHEMA,
    protocolVersion: PROTOCOL_VERSION,
    descriptor: DESCRIPTOR,
    status,
    leaseId,
    owner,
    generation,
    tokenSha256,
    acquiredAt,
    updatedAt,
    expiresAt,
    releaseReceipts,
  };
  return { ...body, leaseDigest: sha256(stable(body)) };
}

function findReleaseReceipt(record, { owner, leaseId, leaseToken }) {
  if (
    typeof leaseId !== "string" ||
    typeof leaseToken !== "string" ||
    !ownerIsValid(owner)
  ) return null;
  const tokenSha256 = sha256(leaseToken);
  return record?.releaseReceipts?.findLast((receipt) => (
    receipt.leaseId === leaseId &&
    same(receipt.owner, owner) &&
    receipt.tokenSha256 === tokenSha256
  )) ?? null;
}

function releasedResult(receipt) {
  return {
    acquired: false,
    reason: "bootstrap_released",
    descriptor: DESCRIPTOR,
    leaseId: receipt.leaseId,
    leaseToken: null,
    owner: receipt.owner,
    generation: receipt.generation,
    acquiredAt: receipt.acquiredAt,
    updatedAt: receipt.releasedAt,
    expiresAt: receipt.expiresAt,
    retryAfter: null,
  };
}

function appendReleaseReceipt(record, { leaseToken, releasedAt }) {
  return [
    ...(record.releaseReceipts ?? []),
    {
      leaseId: record.leaseId,
      owner: record.owner,
      tokenSha256: sha256(leaseToken),
      generation: record.generation,
      acquiredAt: record.acquiredAt,
      releasedAt,
      expiresAt: record.expiresAt,
    },
  ].slice(-MAX_RELEASE_RECEIPTS);
}

function publicResult(record, {
  acquired,
  reason,
  leaseToken = null,
}) {
  return {
    acquired,
    reason,
    descriptor: record.descriptor,
    leaseId: record.leaseId,
    leaseToken,
    owner: record.owner,
    generation: record.generation,
    acquiredAt: record.acquiredAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    retryAfter: record.status === "active" ? record.expiresAt : null,
  };
}

function assertOwnership(current, { owner, leaseId, leaseToken }) {
  const token = validateLeaseToken(leaseToken);
  const id = validateLeaseId(leaseId);
  if (
    current?.status !== "active" ||
    current.leaseId !== id ||
    !same(current.owner, owner) ||
    !tokenMatches(token, current.tokenSha256)
  ) {
    fail(
      "EGO_BOOTSTRAP_LEASE_MISMATCH",
      "Ego bootstrap lease capability does not own the active bootstrap.",
    );
  }
}

export async function egoBootstrapLease({
  action,
  transportStateDir,
  owner,
  leaseId = null,
  leaseToken = null,
  ttlMs = null,
  clock = () => new Date(),
  createToken = randomUUID,
  createLeaseId = randomUUID,
}) {
  if (!["acquire", "renew", "release"].includes(action)) {
    fail(
      "EGO_BOOTSTRAP_LEASE_ACTION_INVALID",
      "Ego bootstrap lease action must be acquire, renew, or release.",
    );
  }
  if (
    (
      action === "acquire" &&
      ((leaseId === null) !== (leaseToken === null))
    ) ||
    (action === "release" && ttlMs !== null)
  ) {
    fail(
      "EGO_BOOTSTRAP_LEASE_INPUT_INVALID",
      "Ego bootstrap lease inputs do not match the requested action.",
    );
  }
  const validatedOwner = validateOwner(owner);
  const effectiveTtlMs = action === "release"
    ? null
    : validateTtl(ttlMs ?? DEFAULT_TTL_MS);
  const canonicalRoot = await prepareDirectory(path.resolve(transportStateDir));
  const paths = egoBootstrapLeasePaths(canonicalRoot);

  return withOwnedFileLock({
    lockPath: paths.lock,
    busyCode: "EGO_BOOTSTRAP_LEASE_BUSY",
    busyMessage: "Another coordinator is updating the Ego bootstrap lease.",
  }, async () => {
    const current = await readRecord(paths.record);
    const now = nowFrom(clock);

    if (action === "acquire") {
      const prescribed = leaseId !== null;
      const token = validateLeaseToken(
        prescribed ? leaseToken : createToken(),
      );
      const nextLeaseId = validateLeaseId(
        prescribed ? leaseId : createLeaseId(),
        prescribed ? "leaseId" : "generated leaseId",
      );
      if (
        current?.status === "active" &&
        Date.parse(current.expiresAt) > now.getTime()
      ) {
        if (
          current.leaseId === nextLeaseId &&
          same(current.owner, validatedOwner) &&
          tokenMatches(token, current.tokenSha256)
        ) {
          return publicResult(current, {
            acquired: true,
            reason: "bootstrap_acquire_resumed",
            leaseToken: token,
          });
        }
        return publicResult(current, {
          acquired: false,
          reason: same(current.owner, validatedOwner)
            ? "bootstrap_already_owned"
            : "bootstrap_in_progress",
        });
      }

      const acquiredAt = now.toISOString();
      const next = buildRecord({
        status: "active",
        leaseId: nextLeaseId,
        owner: validatedOwner,
        generation: (current?.generation ?? 0) + 1,
        tokenSha256: sha256(token),
        acquiredAt,
        updatedAt: acquiredAt,
        expiresAt: new Date(now.getTime() + effectiveTtlMs).toISOString(),
        releaseReceipts: current?.releaseReceipts ?? [],
      });
      await atomicWrite(paths.record, next);
      return publicResult(next, {
        acquired: true,
        reason: current?.status === "active"
          ? "expired_bootstrap_replaced"
          : current?.status === "released"
            ? "released_bootstrap_replaced"
            : "bootstrap_acquired",
        leaseToken: token,
      });
    }

    const validatedReleaseId = action === "release"
      ? validateLeaseId(leaseId)
      : null;
    const validatedReleaseToken = action === "release"
      ? validateLeaseToken(leaseToken)
      : null;
    const priorRelease = action === "release"
      ? findReleaseReceipt(current, {
          owner: validatedOwner,
          leaseId: validatedReleaseId,
          leaseToken: validatedReleaseToken,
        })
      : null;
    if (priorRelease !== null) return releasedResult(priorRelease);

    assertOwnership(current, {
      owner: validatedOwner,
      leaseId,
      leaseToken,
    });

    if (action === "renew") {
      if (Date.parse(current.expiresAt) <= now.getTime()) {
        fail(
          "EGO_BOOTSTRAP_LEASE_EXPIRED",
          "Ego bootstrap lease expired before renewal.",
        );
      }
      const next = buildRecord({
        ...current,
        status: "active",
        tokenSha256: current.tokenSha256,
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + effectiveTtlMs).toISOString(),
        releaseReceipts: current.releaseReceipts,
      });
      await atomicWrite(paths.record, next);
      return publicResult(next, {
        acquired: true,
        reason: "bootstrap_renewed",
        leaseToken,
      });
    }

    const releasedAt = now.toISOString();
    const next = buildRecord({
      ...current,
      status: "released",
      tokenSha256: null,
      updatedAt: releasedAt,
      releaseReceipts: appendReleaseReceipt(current, {
        leaseToken,
        releasedAt,
      }),
    });
    await atomicWrite(paths.record, next);
    return publicResult(next, {
      acquired: false,
      reason: "bootstrap_released",
    });
  });
}
