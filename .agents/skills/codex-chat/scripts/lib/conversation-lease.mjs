import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fail } from "./errors.mjs";
import { withOwnedFileLock } from "./file-lock.mjs";

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stable(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const MAX_LEASE_BYTES = 32 * 1024;

function sameOwner(left, right) {
  return stable(left) === stable(right);
}

function sameAuthority(left, right) {
  return (
    left?.runId === right?.runId &&
    left?.workspaceId === right?.workspaceId &&
    left?.coordinatorId === right?.coordinatorId &&
    left?.workUnitId === right?.workUnitId
  );
}

function descriptorId(descriptor) {
  return sha256(stable(descriptor));
}

async function atomicTextWrite(filePath, contents) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
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
    const directoryHandle = await open(path.dirname(filePath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export function conversationLeasePaths(stateDir, descriptor) {
  const root = path.join(path.resolve(stateDir), ".conversation-leases");
  const id = descriptorId(descriptor);
  return {
    root,
    id,
    record: path.join(root, `${id}.json`),
    lock: path.join(root, ".locks", `${id}.lock`),
  };
}

async function readLease(filePath) {
  const info = await lstat(filePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return null;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > MAX_LEASE_BYTES
  ) {
    fail(
      "CONVERSATION_LEASE_CORRUPT",
      "Conversation lease must be a bounded real file.",
    );
  }
  const raw = await readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      fail(
        "CONVERSATION_LEASE_CHANGED",
        "Conversation lease changed while it was read.",
      );
    }
    throw error;
  });
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("CONVERSATION_LEASE_CORRUPT", "Conversation lease is not valid JSON.");
  }
  const { leaseDigest, ...unsigned } = value ?? {};
  const allowedKeys = new Set([
    "kind",
    "protocolVersion",
    "leaseId",
    "descriptor",
    "owner",
    "status",
    "generation",
    "acquiredAt",
    "updatedAt",
    "leaseDigest",
  ]);
  if (
    value?.kind !== "CODEX_CHAT_CONVERSATION_LEASE_V1" ||
    value.protocolVersion !== 1 ||
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    !["active", "released"].includes(value.status) ||
    !Number.isInteger(value.generation) ||
    value.generation < 1 ||
    typeof value.acquiredAt !== "string" ||
    Number.isNaN(Date.parse(value.acquiredAt)) ||
    typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.updatedAt)) ||
    !value.descriptor ||
    typeof value.descriptor.providerNamespace !== "string" ||
    typeof value.descriptor.type !== "string" ||
    typeof value.descriptor.value !== "string" ||
    value.leaseId !== descriptorId(value.descriptor) ||
    !value.owner ||
    typeof value.owner.runId !== "string" ||
    typeof value.owner.turnId !== "string" ||
    !/^[a-f0-9]{64}$/.test(leaseDigest ?? "") ||
    sha256(stable(unsigned)) !== leaseDigest
  ) {
    fail("CONVERSATION_LEASE_CORRUPT", "Conversation lease digest is invalid.");
  }
  return value;
}

async function prepareLeaseDirectory(paths) {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const locks = path.dirname(paths.lock);
  await mkdir(locks, { recursive: true, mode: 0o700 });
  for (const directory of [paths.root, locks]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail(
        "CONVERSATION_LEASE_DIRECTORY_INVALID",
        "Conversation lease directories must be real directories.",
      );
    }
    await chmod(directory, 0o700);
  }
}

function buildLease({
  descriptor,
  owner,
  status,
  generation,
  acquiredAt,
  updatedAt,
}) {
  const body = {
    kind: "CODEX_CHAT_CONVERSATION_LEASE_V1",
    protocolVersion: 1,
    leaseId: descriptorId(descriptor),
    descriptor,
    owner,
    status,
    generation,
    acquiredAt,
    updatedAt,
  };
  return { ...body, leaseDigest: sha256(stable(body)) };
}

export async function claimConversationLease({
  stateDir,
  descriptor,
  owner,
  at,
  isOwnerTerminal,
}) {
  const paths = conversationLeasePaths(stateDir, descriptor);
  await prepareLeaseDirectory(paths);
  return withOwnedFileLock({
    lockPath: paths.lock,
    busyCode: "CONVERSATION_LEASE_BUSY",
    busyMessage: "Another writer is updating the provider-conversation lease.",
  }, async () => {
    const current = await readLease(paths.record);
    if (
      current &&
      (
        current.leaseId !== paths.id ||
        stable(current.descriptor) !== stable(descriptor)
      )
    ) {
      fail(
        "CONVERSATION_LEASE_CORRUPT",
        "Conversation lease does not match its digest-addressed slot.",
      );
    }
    if (
      current?.status === "active" &&
      !sameAuthority(current.owner, owner)
    ) {
      const replaceable = await isOwnerTerminal(current.owner);
      if (!replaceable) {
        fail(
          "CONVERSATION_LEASE_CONFLICT",
          "The provider conversation is already owned by another active run.",
          {
            leaseId: paths.id,
            ownerRunId: current.owner?.runId ?? null,
          },
        );
      }
    }
    if (
      current?.status === "active" &&
      sameOwner(current.owner, owner)
    ) {
      return { lease: current, idempotent: true };
    }
    const lease = buildLease({
      descriptor,
      owner,
      status: "active",
      generation: (current?.generation ?? 0) + 1,
      acquiredAt: at,
      updatedAt: at,
    });
    await atomicTextWrite(paths.record, `${stable(lease)}\n`);
    return { lease, idempotent: false };
  });
}

export async function releaseConversationLeases({
  stateDir,
  descriptors,
  owner,
  at,
}) {
  const ordered = [...descriptors].sort((left, right) =>
    descriptorId(left).localeCompare(descriptorId(right))
  );
  for (const descriptor of ordered) {
    const paths = conversationLeasePaths(stateDir, descriptor);
    await prepareLeaseDirectory(paths);
    await withOwnedFileLock({
      lockPath: paths.lock,
      busyCode: "CONVERSATION_LEASE_BUSY",
      busyMessage: "Another writer is updating the provider-conversation lease.",
    }, async () => {
      const current = await readLease(paths.record);
      if (!current || current.status === "released") return;
      if (
        current.leaseId !== paths.id ||
        stable(current.descriptor) !== stable(descriptor)
      ) {
        fail(
          "CONVERSATION_LEASE_CORRUPT",
          "Conversation lease does not match its digest-addressed slot.",
        );
      }
      if (!sameAuthority(current.owner, owner)) {
        return;
      }
      const released = buildLease({
        descriptor,
        owner,
        status: "released",
        generation: current.generation,
        acquiredAt: current.acquiredAt,
        updatedAt: at,
      });
      await atomicTextWrite(paths.record, `${stable(released)}\n`);
    });
  }
}
