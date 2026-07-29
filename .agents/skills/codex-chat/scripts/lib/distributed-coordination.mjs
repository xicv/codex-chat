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
import { fail } from "./errors.mjs";
import { holdOwnedFileLock } from "./file-lock.mjs";
import { LIMITS_DISTRIBUTED_V1 } from "./limits.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
export const DISTRIBUTED_COORDINATION_OPERATIONS = Object.freeze([
  "lease.acquire",
  "lease.renew",
  "lease.release",
  "run.append",
  "run.read",
  "conversation.claim",
  "conversation.release",
  "mail.enqueue",
  "mail.claim",
  "mail.ack",
  "mail.cancel",
  "mail.prune",
  "mail.inspect",
  "mail.list",
]);
const OPERATION_SET = new Set(DISTRIBUTED_COORDINATION_OPERATIONS);
const QUERY_OPERATIONS = new Set(["mail.inspect", "mail.list", "run.read"]);
const DEFAULT_LIMITS = Object.freeze({
  mailbox: LIMITS_DISTRIBUTED_V1.mailbox,
});

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stable(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

const digest = (value) =>
  createHash("sha256").update(stable(value)).digest("hex");

function ownValue(record, key) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function normalizeLimits(value = {}) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "mailbox") ||
    (
      value.mailbox !== undefined &&
      (
        !value.mailbox ||
        typeof value.mailbox !== "object" ||
        Array.isArray(value.mailbox) ||
        Object.keys(value.mailbox).some((key) =>
          !Object.hasOwn(DEFAULT_LIMITS.mailbox, key)
        )
      )
    )
  ) {
    fail(
      "COORDINATION_LIMITS_INVALID",
      "Distributed coordination limits are invalid.",
    );
  }
  const mailbox = {
    ...DEFAULT_LIMITS.mailbox,
    ...(value.mailbox ?? {}),
  };
  for (const [key, limit] of Object.entries(mailbox)) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      fail(
        "COORDINATION_LIMITS_INVALID",
        `Distributed coordination limit is invalid: mailbox.${key}`,
      );
    }
    const weakensCeiling =
      key === "minVisibilityTimeoutMs"
        ? limit < DEFAULT_LIMITS.mailbox[key]
        : limit > DEFAULT_LIMITS.mailbox[key];
    if (weakensCeiling) {
      fail(
        "COORDINATION_LIMITS_INVALID",
        `Distributed coordination limit weakens the hard ceiling: mailbox.${key}`,
      );
    }
  }
  if (
    mailbox.maxMessageBytes > mailbox.maxQueuedBytes ||
    mailbox.minVisibilityTimeoutMs > mailbox.maxVisibilityTimeoutMs
  ) {
    fail(
      "COORDINATION_LIMITS_INVALID",
      "Mailbox byte and visibility limits are inconsistent.",
    );
  }
  return { mailbox };
}

function initialState(limits) {
  return {
    kind: "CODEX_CHAT_COORDINATION_STATE_V1",
    protocolVersion: 1,
    sequence: 0,
    lastEventHash: null,
    logicalTimeMs: 0,
    limits,
    leases: {},
    runHeads: {},
    conversations: {},
    mailboxes: {},
    messages: {},
    messageTombstones: {},
    retainedPayloadBytes: 0,
    idempotencyRecords: {},
    idempotencyBytes: 0,
  };
}

function serializedState(state) {
  const body = structuredClone(state);
  return `${stable({ ...body, stateDigest: digest(body) })}\n`;
}

async function readBoundedUtf8(
  filePath,
  maxBytes,
  { optional = false } = {},
) {
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    if (error.code === "ELOOP") {
      fail(
        "COORDINATION_STATE_FILE_INVALID",
        "Coordination state files must not be symbolic links.",
      );
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      fail(
        "COORDINATION_STATE_FILE_INVALID",
        "Coordination state paths must be regular files.",
      );
    }
    if (info.size > maxBytes) {
      fail(
        "COORDINATION_STATE_FILE_TOO_LARGE",
        "Coordination state file exceeds its protocol byte limit.",
      );
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      fail(
        "COORDINATION_STATE_FILE_TOO_LARGE",
        "Coordination state file exceeds its protocol byte limit.",
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail(
        "COORDINATION_STATE_FILE_INVALID",
        "Coordination state file is not valid UTF-8.",
      );
    }
  } finally {
    await handle.close();
  }
}

function parseState(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(
      "COORDINATION_STATE_CORRUPT",
      "Distributed coordination state is not valid JSON.",
    );
  }
  const { stateDigest, ...body } = value ?? {};
  if (
    value?.kind !== "CODEX_CHAT_COORDINATION_STATE_V1" ||
    value.protocolVersion !== 1 ||
    !Number.isInteger(value.sequence) ||
    value.sequence < 0 ||
    (
      value.lastEventHash !== null &&
      !SHA256.test(value.lastEventHash ?? "")
    ) ||
    !Number.isInteger(value.logicalTimeMs) ||
    value.logicalTimeMs < 0 ||
    !value.limits ||
    typeof value.limits !== "object" ||
    Array.isArray(value.limits) ||
    !value.leases ||
    typeof value.leases !== "object" ||
    Array.isArray(value.leases) ||
    !value.runHeads ||
    typeof value.runHeads !== "object" ||
    Array.isArray(value.runHeads) ||
    !value.conversations ||
    typeof value.conversations !== "object" ||
    Array.isArray(value.conversations) ||
    !value.mailboxes ||
    typeof value.mailboxes !== "object" ||
    Array.isArray(value.mailboxes) ||
    !value.messages ||
    typeof value.messages !== "object" ||
    Array.isArray(value.messages) ||
    !value.messageTombstones ||
    typeof value.messageTombstones !== "object" ||
    Array.isArray(value.messageTombstones) ||
    !Number.isSafeInteger(value.retainedPayloadBytes) ||
    value.retainedPayloadBytes < 0 ||
    !value.idempotencyRecords ||
    typeof value.idempotencyRecords !== "object" ||
    Array.isArray(value.idempotencyRecords) ||
    !Number.isSafeInteger(value.idempotencyBytes) ||
    value.idempotencyBytes < 0 ||
    !/^[a-f0-9]{64}$/.test(stateDigest ?? "") ||
    digest(body) !== stateDigest
  ) {
    fail(
      "COORDINATION_STATE_CORRUPT",
      "Distributed coordination state digest is invalid.",
    );
  }
  return body;
}

async function atomicStateWrite(filePath, state) {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const serialized = serializedState(state);
  if (
    Buffer.byteLength(serialized) >
    LIMITS_DISTRIBUTED_V1.state.maxSnapshotBytes
  ) {
    fail(
      "COORDINATION_STATE_CAPACITY",
      "Coordination snapshot exceeds its protocol byte limit.",
    );
  }
  await writeFile(temporary, serialized, {
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

async function appendCoordinationEvent(filePath, event) {
  const serialized = `${stable(event)}\n`;
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY |
      fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  ).catch((error) => {
    if (error.code === "ELOOP") {
      fail(
        "COORDINATION_STATE_FILE_INVALID",
        "Coordination state files must not be symbolic links.",
      );
    }
    throw error;
  });
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size + Buffer.byteLength(serialized) >
        LIMITS_DISTRIBUTED_V1.state.maxJournalBytes
    ) {
      fail(
        info.isFile()
          ? "COORDINATION_JOURNAL_CAPACITY"
          : "COORDINATION_STATE_FILE_INVALID",
        info.isFile()
          ? "Coordination journal reached its protocol byte limit."
          : "Coordination state paths must be regular files.",
      );
    }
    await handle.appendFile(serialized);
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function repairPartialEventTail(filePath, complete, partial) {
  const partialDigest = createHash("sha256").update(partial).digest("hex");
  await writeFile(
    path.join(
      path.dirname(filePath),
      `events.partial-${partialDigest}.bin`,
    ),
    partial,
    { mode: 0o600, flag: "wx" },
  ).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const temporary = `${filePath}.repair-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, complete, { mode: 0o600, flag: "wx" });
  try {
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
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

async function readCoordinationEvents(filePath, limits) {
  let raw = await readBoundedUtf8(
    filePath,
    LIMITS_DISTRIBUTED_V1.state.maxJournalBytes,
    { optional: true },
  ) ?? "";
  if (raw === "") return [];
  let lines = raw.split("\n");
  if (lines.at(-1) !== "") {
    const partial = lines.pop();
    const complete = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    await repairPartialEventTail(filePath, complete, partial);
    raw = complete;
    lines = raw.split("\n");
  }
  lines.pop();
  const events = [];
  let previousHash = null;
  const expectedLimitsDigest = digest(limits);
  for (let index = 0; index < lines.length; index += 1) {
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch {
      fail(
        "COORDINATION_EVENT_LOG_CORRUPT",
        `Coordination event ${index + 1} is not valid JSON.`,
      );
    }
    const { hash, ...unsigned } = event ?? {};
    if (
      event?.kind !== "CODEX_CHAT_COORDINATION_EVENT_V1" ||
      event.protocolVersion !== 1 ||
      event.sequence !== index + 1 ||
      event.previousHash !== previousHash ||
      event.limitsDigest !== expectedLimitsDigest ||
      !Number.isSafeInteger(event.atMs) ||
      event.atMs < 0 ||
      !event.request ||
      !Array.isArray(event.assignments) ||
      event.assignments.some((value) => !ID.test(value ?? "")) ||
      !SHA256.test(event.resultDigest ?? "") ||
      !SHA256.test(hash ?? "") ||
      digest(unsigned) !== hash
    ) {
      fail(
        "COORDINATION_EVENT_HASH_INVALID",
        `Coordination event hash chain is invalid at sequence ${index + 1}.`,
      );
    }
    previousHash = hash;
    events.push(event);
  }
  return events;
}

function validateId(value, label) {
  if (!ID.test(value ?? "")) {
    fail("COORDINATION_INPUT_INVALID", `${label} is invalid.`);
  }
  return value;
}

function validateTtl(value) {
  if (
    !Number.isInteger(value) ||
    value < LIMITS_DISTRIBUTED_V1.lease.minTtlMs ||
    value > LIMITS_DISTRIBUTED_V1.lease.maxTtlMs
  ) {
    fail(
      "COORDINATION_TTL_INVALID",
      `ttlMs must be between ${LIMITS_DISTRIBUTED_V1.lease.minTtlMs} and ${LIMITS_DISTRIBUTED_V1.lease.maxTtlMs}.`,
    );
  }
  return value;
}

function validateFenceData(data, nowMs) {
  const workspaceId = validateId(data?.workspaceId, "workspaceId");
  const runId = validateId(data?.runId, "runId");
  const ownerId = validateId(data?.ownerId, "ownerId");
  const leaseId = validateId(data?.leaseId, "leaseId");
  if (
    !Number.isSafeInteger(data?.fencingToken) ||
    data.fencingToken < 1
  ) {
    fail("COORDINATION_INPUT_INVALID", "fencingToken is invalid.");
  }
  return { workspaceId, runId, ownerId, leaseId, nowMs };
}

function leaseKey(workspaceId, runId) {
  return digest({ workspaceId, runId });
}

function activeLease(state, data, nowMs) {
  const validated = validateFenceData(data, nowMs);
  const current = state.leases[
    leaseKey(validated.workspaceId, validated.runId)
  ];
  if (
    !current ||
    current.status !== "active" ||
    current.expiresAtMs <= nowMs ||
    current.ownerId !== validated.ownerId ||
    current.leaseId !== validated.leaseId ||
    current.fencingToken !== data.fencingToken
  ) {
    fail(
      "STALE_FENCE",
      "Coordinator lease is absent, expired, superseded, or owned by another coordinator.",
    );
  }
  return current;
}

function leaseResult(lease) {
  return {
    workspaceId: lease.workspaceId,
    runId: lease.runId,
    ownerId: lease.ownerId,
    leaseId: lease.leaseId,
    coordinatorEpoch: lease.coordinatorEpoch,
    fencingToken: lease.fencingToken,
    acquiredAt: new Date(lease.acquiredAtMs).toISOString(),
    expiresAt: new Date(lease.expiresAtMs).toISOString(),
  };
}

function applyLeaseAcquire(state, data, { nowMs, randomId }) {
  const workspaceId = validateId(data?.workspaceId, "workspaceId");
  const runId = validateId(data?.runId, "runId");
  const ownerId = validateId(data?.ownerId, "ownerId");
  const ttlMs = validateTtl(data?.ttlMs);
  const key = leaseKey(workspaceId, runId);
  const current = state.leases[key];
  if (current?.status === "active" && current.expiresAtMs > nowMs) {
    fail(
      "COORDINATOR_LEASE_HELD",
      "Another coordinator epoch is still active for this run.",
      {
        expiresAt: new Date(current.expiresAtMs).toISOString(),
        ownerId: current.ownerId,
      },
    );
  }
  const coordinatorEpoch = (current?.coordinatorEpoch ?? 0) + 1;
  if (!Number.isSafeInteger(coordinatorEpoch)) {
    fail("FENCING_TOKEN_EXHAUSTED", "Coordinator fencing token is exhausted.");
  }
  const leaseId = validateId(randomId(), "generated leaseId");
  const lease = {
    workspaceId,
    runId,
    ownerId,
    leaseId,
    coordinatorEpoch,
    fencingToken: coordinatorEpoch,
    acquiredAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    status: "active",
  };
  state.leases[key] = lease;
  return leaseResult(lease);
}

function applyLeaseRenew(state, data, { nowMs }) {
  const ttlMs = validateTtl(data?.ttlMs);
  const current = activeLease(state, data, nowMs);
  current.expiresAtMs = nowMs + ttlMs;
  return leaseResult(current);
}

function applyLeaseRelease(state, data, { nowMs }) {
  const current = activeLease(state, data, nowMs);
  current.status = "released";
  current.expiresAtMs = nowMs;
  return { ...leaseResult(current), status: "released" };
}

function applyRunAppend(state, data, { nowMs }) {
  const lease = activeLease(state, data, nowMs);
  const eventId = validateId(data?.eventId, "eventId");
  const eventType = validateId(data?.eventType, "eventType");
  if (
    !SHA256.test(data?.payloadSha256 ?? "") ||
    !Number.isInteger(data?.expectedSequence) ||
    data.expectedSequence < 0 ||
    (
      data.expectedHash !== null &&
      !SHA256.test(data.expectedHash ?? "")
    ) ||
    typeof data.terminal !== "boolean"
  ) {
    fail(
      "COORDINATION_INPUT_INVALID",
      "run.append requires an event ID/type, payload digest, exact expected head, and terminal flag.",
    );
  }
  const key = leaseKey(lease.workspaceId, lease.runId);
  const current = state.runHeads[key] ?? {
    workspaceId: lease.workspaceId,
    runId: lease.runId,
    eventSequence: 0,
    eventHash: null,
    terminal: false,
    eventIds: {},
  };
  if (current.terminal) {
    fail(
      "DISTRIBUTED_RUN_TERMINAL",
      "Distributed run stream is already terminal.",
    );
  }
  if (
    current.eventSequence !== data.expectedSequence ||
    current.eventHash !== data.expectedHash
  ) {
    fail(
      "DISTRIBUTED_RUN_HEAD_CONFLICT",
      "Expected distributed run head does not match the authoritative stream.",
      {
        actualSequence: current.eventSequence,
        actualHash: current.eventHash,
      },
    );
  }
  if (
    current.eventSequence >=
    LIMITS_DISTRIBUTED_V1.state.maxRunEvents
  ) {
    fail(
      "DISTRIBUTED_RUN_EVENT_CAPACITY",
      "Distributed run stream reached its event capacity.",
    );
  }
  if (ownValue(current.eventIds, eventId)) {
    fail(
      "DISTRIBUTED_RUN_EVENT_ID_CONFLICT",
      "Distributed run event ID was already used.",
    );
  }
  const eventSequence = current.eventSequence + 1;
  const eventHash = digest({
    workspaceId: lease.workspaceId,
    runId: lease.runId,
    eventSequence,
    previousHash: current.eventHash,
    eventId,
    eventType,
    payloadSha256: data.payloadSha256,
    fencingToken: lease.fencingToken,
    terminal: data.terminal,
  });
  const next = {
    ...current,
    eventSequence,
    eventHash,
    terminal: data.terminal,
    eventIds: {
      ...current.eventIds,
      [eventId]: eventHash,
    },
  };
  state.runHeads[key] = next;
  return {
    workspaceId: next.workspaceId,
    runId: next.runId,
    eventSequence: next.eventSequence,
    eventHash: next.eventHash,
    terminal: next.terminal,
    fencingToken: lease.fencingToken,
  };
}

function validateConversationDescriptor(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) =>
      !["providerNamespace", "type", "value"].includes(key)
    ) ||
    !ID.test(value.providerNamespace ?? "") ||
    !ID.test(value.type ?? "") ||
    typeof value.value !== "string" ||
    value.value.length === 0 ||
    Buffer.byteLength(value.value) > 4096 ||
    /[\0\r\n]/.test(value.value)
  ) {
    fail(
      "CONVERSATION_DESCRIPTOR_INVALID",
      "Conversation descriptor must bind provider namespace, type, and a bounded single-line value.",
    );
  }
  return {
    providerNamespace: value.providerNamespace,
    type: value.type,
    value: value.value,
  };
}

function conversationKey(descriptor) {
  return digest(descriptor);
}

function publicConversationLease(lease) {
  return {
    descriptor: structuredClone(lease.descriptor),
    workspaceId: lease.workspaceId,
    runId: lease.runId,
    ownerId: lease.ownerId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    generation: lease.generation,
    status: lease.status,
    acquiredAt: new Date(lease.acquiredAtMs).toISOString(),
    updatedAt: new Date(lease.updatedAtMs).toISOString(),
  };
}

function applyConversationClaim(state, data, { nowMs }) {
  const coordinator = activeLease(state, data, nowMs);
  const claimantHead = state.runHeads[
    leaseKey(coordinator.workspaceId, coordinator.runId)
  ];
  if (claimantHead?.terminal) {
    fail(
      "DISTRIBUTED_RUN_TERMINAL",
      "Terminal distributed runs cannot claim provider conversations.",
    );
  }
  const descriptor = validateConversationDescriptor(data?.descriptor);
  const key = conversationKey(descriptor);
  const current = state.conversations[key];
  const sameRun =
    current?.workspaceId === coordinator.workspaceId &&
    current?.runId === coordinator.runId;
  const ownerTerminal = current
    ? state.runHeads[
        leaseKey(current.workspaceId, current.runId)
      ]?.terminal === true
    : false;
  if (
    current?.status === "active" &&
    !sameRun &&
    !ownerTerminal
  ) {
    fail(
      "CONVERSATION_LEASE_CONFLICT",
      "Provider conversation is owned by another non-terminal distributed run.",
      {
        ownerRunId: current.runId,
        ownerWorkspaceId: current.workspaceId,
      },
    );
  }
  const replacing =
    !current ||
    current.status !== "active" ||
    (!sameRun && ownerTerminal);
  const lease = {
    descriptor,
    workspaceId: coordinator.workspaceId,
    runId: coordinator.runId,
    ownerId: coordinator.ownerId,
    leaseId: coordinator.leaseId,
    fencingToken: coordinator.fencingToken,
    generation: replacing ? (current?.generation ?? 0) + 1 : current.generation,
    status: "active",
    acquiredAtMs: replacing ? nowMs : current.acquiredAtMs,
    updatedAtMs: nowMs,
  };
  state.conversations[key] = lease;
  return publicConversationLease(lease);
}

function applyConversationRelease(state, data, { nowMs }) {
  const coordinator = activeLease(state, data, nowMs);
  const descriptor = validateConversationDescriptor(data?.descriptor);
  const key = conversationKey(descriptor);
  const current = state.conversations[key];
  if (
    !current ||
    current.status !== "active" ||
    current.workspaceId !== coordinator.workspaceId ||
    current.runId !== coordinator.runId
  ) {
    fail(
      "CONVERSATION_LEASE_CONFLICT",
      "Provider conversation is not owned by the active distributed run.",
    );
  }
  current.status = "released";
  current.ownerId = coordinator.ownerId;
  current.leaseId = coordinator.leaseId;
  current.fencingToken = coordinator.fencingToken;
  current.updatedAtMs = nowMs;
  return publicConversationLease(current);
}

function validateRoute(value) {
  const keys = [
    "workspaceId",
    "coordinatorId",
    "runId",
    "workUnitId",
    "agentId",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    fail(
      "MAILBOX_ROUTE_INVALID",
      "Mailbox route must contain the complete immutable route tuple.",
    );
  }
  return Object.fromEntries(
    keys.map((key) => [key, validateId(value[key], `route.${key}`)]),
  );
}

function routeKey(route) {
  return digest(route);
}

function validateJson(
  value,
  depth = 0,
  budget = { nodes: 0 },
  failure = {
    code: "MAILBOX_PAYLOAD_INVALID",
    message: "Mailbox payload must contain bounded JSON values.",
  },
) {
  budget.nodes += 1;
  if (depth > 32 || budget.nodes > 10_000) {
    fail(failure.code, failure.message);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      validateJson(item, depth + 1, budget, failure);
    }
    return;
  }
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    fail(failure.code, failure.message);
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      ["__proto__", "constructor", "prototype"].includes(key) ||
      /[\0\r\n]/.test(key)
    ) {
      fail(failure.code, failure.message);
    }
    validateJson(item, depth + 1, budget, failure);
  }
}

export function canonicalCoordinationSha256(value) {
  validateJson(
    value,
    0,
    { nodes: 0 },
    {
      code: "COORDINATION_CANONICAL_JSON_INVALID",
      message: "Canonical coordination input must contain bounded JSON values.",
    },
  );
  const serialized = stable(value);
  if (
    Buffer.byteLength(serialized) >
    LIMITS_DISTRIBUTED_V1.control.maxRequestBytes
  ) {
    fail(
      "COORDINATION_CANONICAL_JSON_INVALID",
      "Canonical coordination input exceeds the protocol byte limit.",
    );
  }
  return createHash("sha256").update(serialized).digest("hex");
}

function validateExpectedRunHead(state, route, expected) {
  const current = state.runHeads[leaseKey(route.workspaceId, route.runId)];
  if (
    !current ||
    current.terminal ||
    !expected ||
    typeof expected !== "object" ||
    Array.isArray(expected) ||
    expected.eventSequence !== current.eventSequence ||
    expected.eventHash !== current.eventHash
  ) {
    fail(
      current?.terminal
        ? "DISTRIBUTED_RUN_TERMINAL"
        : "DISTRIBUTED_RUN_HEAD_CONFLICT",
      "Mailbox mutation does not bind the current non-terminal distributed run head.",
      {
        actualSequence: current?.eventSequence ?? 0,
        actualHash: current?.eventHash ?? null,
      },
    );
  }
  return current;
}

function publicMessage(message, { includePayload = false } = {}) {
  return {
    route: structuredClone(message.route),
    messageId: message.messageId,
    correlationId: message.correlationId,
    causalParentId: message.causalParentId,
    senderId: message.senderId,
    payloadSha256: message.payloadSha256,
    payloadBytes: message.payloadBytes,
    expectedRunHead: structuredClone(message.expectedRunHead),
    fencingToken: message.fencingToken,
    status: message.status,
    deliveryAttempt: message.deliveryAttempt,
    enqueuedAt: new Date(message.enqueuedAtMs).toISOString(),
    ...(message.visibilityExpiresAtMs !== null
      ? {
          visibilityExpiresAt: new Date(
            message.visibilityExpiresAtMs,
          ).toISOString(),
        }
      : {}),
    ...(includePayload ? { payload: structuredClone(message.payload) } : {}),
    ...(message.cancellation
      ? { cancellation: structuredClone(message.cancellation) }
      : {}),
  };
}

function activeMailboxMessages(state, mailbox) {
  return mailbox.messageIds
    .map((messageId) => ownValue(state.messages, messageId))
    .filter((message) =>
      message && ["queued", "in_flight"].includes(message.status)
    );
}

function applyMailEnqueue(state, data, { nowMs }) {
  const coordinator = activeLease(state, data, nowMs);
  const route = validateRoute(data?.route);
  if (
    route.workspaceId !== coordinator.workspaceId ||
    route.runId !== coordinator.runId
  ) {
    fail(
      "MAILBOX_ROUTE_MISMATCH",
      "Mailbox route does not match the active coordinator lease.",
    );
  }
  validateExpectedRunHead(state, route, data?.expectedRunHead);
  const messageId = validateId(data?.messageId, "messageId");
  const correlationId = validateId(data?.correlationId, "correlationId");
  const causalParentId =
    data?.causalParentId === null
      ? null
      : validateId(data?.causalParentId, "causalParentId");
  const senderId = validateId(data?.senderId, "senderId");
  validateJson(data?.payload);
  const payloadBytes = Buffer.byteLength(stable(data.payload));
  if (
    payloadBytes > state.limits.mailbox.maxMessageBytes ||
    !SHA256.test(data?.payloadSha256 ?? "") ||
    digest(data.payload) !== data.payloadSha256
  ) {
    fail(
      "MAILBOX_PAYLOAD_INVALID",
      "Mailbox payload is oversized or does not match its digest.",
    );
  }
  if (
    ownValue(state.messages, messageId) ||
    ownValue(state.messageTombstones, messageId)
  ) {
    fail(
      "MAILBOX_MESSAGE_ID_CONFLICT",
      "Mailbox message ID was already used.",
    );
  }
  const key = routeKey(route);
  const mailbox = state.mailboxes[key] ?? { route, messageIds: [] };
  if (
    mailbox.messageIds.length >=
    state.limits.mailbox.maxRetainedMessages
  ) {
    fail(
      "MAILBOX_RETENTION_REQUIRED",
      "Mailbox retained-message capacity is exhausted; prune finalized messages.",
      {
        retainedMessages: mailbox.messageIds.length,
      },
    );
  }
  const active = activeMailboxMessages(state, mailbox);
  const activeBytes = active.reduce(
    (total, message) => total + message.payloadBytes,
    0,
  );
  if (
    active.length >= state.limits.mailbox.maxQueuedMessages ||
    activeBytes + payloadBytes > state.limits.mailbox.maxQueuedBytes ||
    state.retainedPayloadBytes + payloadBytes >
      LIMITS_DISTRIBUTED_V1.state.maxRetainedPayloadBytes
  ) {
    fail(
      "MAILBOX_BACKPRESSURE",
      "Mailbox count or byte budget is exhausted.",
      {
        activeMessages: active.length,
        activeBytes,
      },
    );
  }
  const message = {
    route,
    messageId,
    correlationId,
    causalParentId,
    senderId,
    payload: structuredClone(data.payload),
    payloadSha256: data.payloadSha256,
    payloadBytes,
    expectedRunHead: {
      eventSequence: data.expectedRunHead.eventSequence,
      eventHash: data.expectedRunHead.eventHash,
    },
    fencingToken: coordinator.fencingToken,
    status: "queued",
    deliveryAttempt: 0,
    enqueuedAtMs: nowMs,
    consumerId: null,
    claimToken: null,
    visibilityExpiresAtMs: null,
    acknowledgedAtMs: null,
    cancelledAtMs: null,
    cancellation: null,
  };
  state.messages[messageId] = message;
  state.retainedPayloadBytes += payloadBytes;
  state.mailboxes[key] = {
    route,
    messageIds: [...mailbox.messageIds, messageId],
  };
  return publicMessage(message);
}

function validateVisibilityTimeout(state, value) {
  if (
    !Number.isInteger(value) ||
    value < state.limits.mailbox.minVisibilityTimeoutMs ||
    value > state.limits.mailbox.maxVisibilityTimeoutMs
  ) {
    fail(
      "MAILBOX_VISIBILITY_INVALID",
      "Mailbox visibility timeout is outside configured limits.",
    );
  }
  return value;
}

function applyMailClaim(state, data, { nowMs, randomId }) {
  const coordinator = activeLease(state, data, nowMs);
  const route = validateRoute(data?.route);
  if (
    route.workspaceId !== coordinator.workspaceId ||
    route.runId !== coordinator.runId
  ) {
    fail(
      "MAILBOX_ROUTE_MISMATCH",
      "Mailbox route does not match the active coordinator lease.",
    );
  }
  const head = state.runHeads[leaseKey(route.workspaceId, route.runId)];
  if (head?.terminal) {
    fail("DISTRIBUTED_RUN_TERMINAL", "Terminal runs cannot claim new work.");
  }
  const consumerId = validateId(data?.consumerId, "consumerId");
  const visibilityTimeoutMs = validateVisibilityTimeout(
    state,
    data?.visibilityTimeoutMs,
  );
  const mailbox = state.mailboxes[routeKey(route)] ?? {
    route,
    messageIds: [],
  };
  const messages = mailbox.messageIds
    .map((messageId) => ownValue(state.messages, messageId))
    .filter(Boolean);
  for (const message of messages) {
    if (
      message.status === "in_flight" &&
      message.visibilityExpiresAtMs <= nowMs
    ) {
      message.status = "queued";
      message.consumerId = null;
      message.claimToken = null;
      message.visibilityExpiresAtMs = null;
    }
  }
  const inFlight = messages.filter(
    (message) => message.status === "in_flight",
  ).length;
  if (inFlight >= state.limits.mailbox.maxInFlight) {
    fail(
      "MAILBOX_IN_FLIGHT_LIMIT",
      "Mailbox in-flight claim limit is exhausted.",
    );
  }
  const message = messages.find(
    (candidate) =>
      candidate.status === "queued" &&
      candidate.fencingToken === coordinator.fencingToken,
  );
  if (!message) {
    return { message: null, claimToken: null };
  }
  const claimToken = validateId(randomId(), "generated claimToken");
  message.status = "in_flight";
  message.deliveryAttempt += 1;
  message.consumerId = consumerId;
  message.claimToken = claimToken;
  message.visibilityExpiresAtMs = nowMs + visibilityTimeoutMs;
  return {
    message: publicMessage(message, { includePayload: true }),
    claimToken,
  };
}

function findMailboxMessage(state, route, messageId) {
  const message = ownValue(state.messages, messageId);
  if (!message || routeKey(message.route) !== routeKey(route)) {
    fail(
      "MAILBOX_MESSAGE_NOT_FOUND",
      "Mailbox message does not exist on the addressed route.",
    );
  }
  return message;
}

function applyMailAck(state, data, { nowMs }) {
  const coordinator = activeLease(state, data, nowMs);
  const route = validateRoute(data?.route);
  const messageId = validateId(data?.messageId, "messageId");
  const consumerId = validateId(data?.consumerId, "consumerId");
  const claimToken = validateId(data?.claimToken, "claimToken");
  const message = findMailboxMessage(state, route, messageId);
  if (
    route.workspaceId !== coordinator.workspaceId ||
    route.runId !== coordinator.runId ||
    message.fencingToken !== coordinator.fencingToken
  ) {
    fail("STALE_FENCE", "Mailbox acknowledgement uses a stale fence.");
  }
  if (
    message.status !== "in_flight" ||
    message.visibilityExpiresAtMs <= nowMs ||
    message.consumerId !== consumerId ||
    message.claimToken !== claimToken
  ) {
    fail(
      "MAILBOX_CLAIM_CONFLICT",
      "Mailbox acknowledgement does not own the active delivery claim.",
    );
  }
  message.status = "acknowledged";
  message.acknowledgedAtMs = nowMs;
  message.consumerId = null;
  message.claimToken = null;
  message.visibilityExpiresAtMs = null;
  return publicMessage(message);
}

function applyMailCancel(state, data, { nowMs }) {
  const coordinator = activeLease(state, data, nowMs);
  const route = validateRoute(data?.route);
  const messageId = validateId(data?.messageId, "messageId");
  const cancellationId = validateId(
    data?.cancellationId,
    "cancellationId",
  );
  const causalParentId = validateId(
    data?.causalParentId,
    "causalParentId",
  );
  if (
    typeof data?.reason !== "string" ||
    data.reason.length === 0 ||
    Buffer.byteLength(data.reason) > 1024 ||
    /[\0\r]/.test(data.reason)
  ) {
    fail(
      "MAILBOX_CANCELLATION_INVALID",
      "Cancellation reason must be bounded UTF-8/LF text.",
    );
  }
  const message = findMailboxMessage(state, route, messageId);
  if (
    route.workspaceId !== coordinator.workspaceId ||
    route.runId !== coordinator.runId
  ) {
    fail(
      "MAILBOX_ROUTE_MISMATCH",
      "Cancellation route does not match the active coordinator lease.",
    );
  }
  if (causalParentId !== message.messageId) {
    fail(
      "MAILBOX_CANCELLATION_INVALID",
      "Cancellation causal parent must be the addressed message.",
    );
  }
  if (message.status === "acknowledged") {
    fail(
      "MAILBOX_ALREADY_ACKNOWLEDGED",
      "Acknowledged work cannot be retroactively cancelled.",
    );
  }
  if (message.status === "cancelled") {
    fail(
      "MAILBOX_ALREADY_CANCELLED",
      "Mailbox message is already cancelled.",
    );
  }
  message.status = "cancelled";
  message.cancelledAtMs = nowMs;
  message.consumerId = null;
  message.claimToken = null;
  message.visibilityExpiresAtMs = null;
  message.cancellation = {
    cancellationId,
    causalParentId,
    reason: data.reason,
    ownerId: coordinator.ownerId,
    leaseId: coordinator.leaseId,
    fencingToken: coordinator.fencingToken,
    cancelledAt: new Date(nowMs).toISOString(),
  };
  return publicMessage(message);
}

function applyMailPrune(state, data, { nowMs }) {
  const coordinator = activeLease(state, data, nowMs);
  const route = validateRoute(data?.route);
  if (
    route.workspaceId !== coordinator.workspaceId ||
    route.runId !== coordinator.runId
  ) {
    fail(
      "MAILBOX_ROUTE_MISMATCH",
      "Prune route does not match the active coordinator lease.",
    );
  }
  if (
    !Array.isArray(data?.messageIds) ||
    data.messageIds.length === 0 ||
    data.messageIds.length > state.limits.mailbox.maxPruneBatch
  ) {
    fail(
      "MAILBOX_PRUNE_INVALID",
      "Prune requires a non-empty bounded messageIds array.",
    );
  }
  const messageIds = data.messageIds.map((messageId) =>
    validateId(messageId, "messageId")
  );
  if (new Set(messageIds).size !== messageIds.length) {
    fail(
      "MAILBOX_PRUNE_INVALID",
      "Prune messageIds must be unique.",
    );
  }
  const messages = messageIds.map((messageId) =>
    findMailboxMessage(state, route, messageId)
  );
  if (
    messages.some((message) =>
      !["acknowledged", "cancelled"].includes(message.status)
    )
  ) {
    fail(
      "MAILBOX_MESSAGE_NOT_FINAL",
      "Only acknowledged or cancelled mailbox messages may be pruned.",
    );
  }
  const tombstoneCount = Object.keys(state.messageTombstones).length;
  if (
    tombstoneCount + messages.length >
    LIMITS_DISTRIBUTED_V1.state.maxMessageTombstones
  ) {
    fail(
      "MAILBOX_TOMBSTONE_CAPACITY",
      "Mailbox message tombstone capacity is exhausted; rotate the control-plane segment.",
    );
  }
  const key = routeKey(route);
  const mailbox = state.mailboxes[key];
  const pruned = new Set(messageIds);
  for (const message of messages) {
    state.messageTombstones[message.messageId] = {
      routeSha256: key,
      payloadSha256: message.payloadSha256,
      status: message.status,
      finalizedAtMs:
        message.acknowledgedAtMs ?? message.cancelledAtMs,
      prunedAtMs: nowMs,
    };
    state.retainedPayloadBytes -= message.payloadBytes;
    delete state.messages[message.messageId];
  }
  mailbox.messageIds = mailbox.messageIds.filter(
    (messageId) => !pruned.has(messageId),
  );
  return {
    route: structuredClone(route),
    prunedMessageIds: messageIds,
    remainingMessages: mailbox.messageIds.length,
  };
}

function applyMutation(state, request, runtime) {
  switch (request.operation) {
    case "lease.acquire":
      return applyLeaseAcquire(state, request.data, runtime);
    case "lease.renew":
      return applyLeaseRenew(state, request.data, runtime);
    case "lease.release":
      return applyLeaseRelease(state, request.data, runtime);
    case "run.append":
      return applyRunAppend(state, request.data, runtime);
    case "conversation.claim":
      return applyConversationClaim(state, request.data, runtime);
    case "conversation.release":
      return applyConversationRelease(state, request.data, runtime);
    case "mail.enqueue":
      return applyMailEnqueue(state, request.data, runtime);
    case "mail.claim":
      return applyMailClaim(state, request.data, runtime);
    case "mail.ack":
      return applyMailAck(state, request.data, runtime);
    case "mail.cancel":
      return applyMailCancel(state, request.data, runtime);
    case "mail.prune":
      return applyMailPrune(state, request.data, runtime);
    default:
      fail(
        "COORDINATION_OPERATION_UNSUPPORTED",
        `Unsupported coordination operation: ${request.operation}`,
      );
  }
}

function applyQuery(state, request) {
  switch (request.operation) {
    case "mail.inspect": {
      const route = validateRoute(request.data?.route);
      const messageId = validateId(request.data?.messageId, "messageId");
      return publicMessage(
        findMailboxMessage(state, route, messageId),
        { includePayload: true },
      );
    }
    case "mail.list": {
      const route = validateRoute(request.data?.route);
      const mailbox = state.mailboxes[routeKey(route)] ?? {
        route,
        messageIds: [],
      };
      return mailbox.messageIds
        .map((messageId) => ownValue(state.messages, messageId))
        .filter(Boolean)
        .map((message) => publicMessage(message));
    }
    case "run.read": {
      const workspaceId = validateId(
        request.data?.workspaceId,
        "workspaceId",
      );
      const runId = validateId(request.data?.runId, "runId");
      const current = state.runHeads[leaseKey(workspaceId, runId)] ?? null;
      return current
        ? {
            workspaceId,
            runId,
            eventSequence: current.eventSequence,
            eventHash: current.eventHash,
            terminal: current.terminal,
          }
        : null;
    }
    default:
      fail(
        "COORDINATION_OPERATION_UNSUPPORTED",
        `Unsupported coordination query: ${request.operation}`,
      );
  }
}

function validateRequest(request) {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    typeof request.operation !== "string" ||
    !OPERATION_SET.has(request.operation) ||
    Object.keys(request).some((key) =>
      !["operation", "idempotencyKey", "data"].includes(key)
    ) ||
    !request.data ||
    typeof request.data !== "object" ||
    Array.isArray(request.data) ||
    Object.keys(request.data).length > 32 ||
    (
      !QUERY_OPERATIONS.has(request.operation) &&
      !ID.test(request.idempotencyKey ?? "")
    ) ||
    (
      QUERY_OPERATIONS.has(request.operation) &&
      request.idempotencyKey !== undefined
    )
  ) {
    fail(
      "COORDINATION_REQUEST_INVALID",
      "Coordination request has invalid operation, idempotency, or data fields.",
    );
  }
  validateJson(
    request,
    0,
    { nodes: 0 },
    {
      code: "COORDINATION_REQUEST_INVALID",
      message: "Coordination request must contain bounded JSON values.",
    },
  );
  if (
    Buffer.byteLength(stable(request)) >
    LIMITS_DISTRIBUTED_V1.control.maxRequestBytes
  ) {
    fail(
      "COORDINATION_REQUEST_INVALID",
      "Coordination request exceeds the protocol byte limit.",
    );
  }
}

function replayCoordinationEvents(events, limits) {
  const replayed = initialState(limits);
  for (const event of events) {
    if (
      Object.keys(replayed.idempotencyRecords).length >=
      LIMITS_DISTRIBUTED_V1.state.maxIdempotencyRecords
    ) {
      fail(
        "COORDINATION_EVENT_LOG_CORRUPT",
        "Coordination journal exceeds idempotency record capacity.",
      );
    }
    validateRequest(event.request);
    if (QUERY_OPERATIONS.has(event.request.operation)) {
      fail(
        "COORDINATION_EVENT_LOG_CORRUPT",
        "Read-only coordination queries cannot appear in the mutation journal.",
      );
    }
    if (event.atMs < replayed.logicalTimeMs) {
      fail(
        "COORDINATION_EVENT_LOG_CORRUPT",
        "Coordination journal logical time moved backwards.",
      );
    }
    const assignments = [...event.assignments];
    const result = applyMutation(replayed, event.request, {
      nowMs: event.atMs,
      randomId: () => {
        if (assignments.length === 0) {
          fail(
            "COORDINATION_EVENT_LOG_CORRUPT",
            "Coordination journal lacks a generated assignment.",
          );
        }
        return assignments.shift();
      },
    });
    if (
      assignments.length !== 0 ||
      digest(result) !== event.resultDigest
    ) {
      fail(
        "COORDINATION_EVENT_LOG_CORRUPT",
        "Coordination journal replay does not reproduce its recorded result.",
      );
    }
    const requestDigest = digest({
      operation: event.request.operation,
      data: event.request.data,
    });
    if (
      ownValue(
        replayed.idempotencyRecords,
        event.request.idempotencyKey,
      )
    ) {
      fail(
        "COORDINATION_EVENT_LOG_CORRUPT",
        "Coordination journal repeats an idempotency key.",
      );
    }
    replayed.sequence = event.sequence;
    replayed.lastEventHash = event.hash;
    replayed.logicalTimeMs = event.atMs;
    const idempotencyRecord = {
      operation: event.request.operation,
      requestDigest,
      result,
      sequence: event.sequence,
    };
    const idempotencyBytes = Buffer.byteLength(stable(idempotencyRecord));
    if (
      replayed.idempotencyBytes + idempotencyBytes >
      LIMITS_DISTRIBUTED_V1.state.maxIdempotencyBytes
    ) {
      fail(
        "COORDINATION_EVENT_LOG_CORRUPT",
        "Coordination journal exceeds idempotency retention capacity.",
      );
    }
    replayed.idempotencyRecords[event.request.idempotencyKey] =
      idempotencyRecord;
    replayed.idempotencyBytes += idempotencyBytes;
  }
  return replayed;
}

async function prepareStateDirectory(stateDir) {
  if (
    typeof stateDir !== "string" ||
    stateDir.length === 0 ||
    stateDir.includes("\0")
  ) {
    fail(
      "COORDINATION_STATE_DIRECTORY_INVALID",
      "Coordination state directory is invalid.",
    );
  }
  const absolute = path.resolve(stateDir);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(
      "COORDINATION_STATE_DIRECTORY_INVALID",
      "Coordination state must use a real directory.",
    );
  }
  await chmod(absolute, 0o700);
  return realpath(absolute);
}

export async function openCoordinationControlPlane({
  stateDir,
  clock = () => Date.now(),
  randomId = () => randomUUID(),
  limits: limitOverrides = {},
}) {
  if (typeof clock !== "function" || typeof randomId !== "function") {
    fail(
      "COORDINATION_CONTROL_PLANE_CONFIG_INVALID",
      "Coordination control-plane clock and random ID source must be functions.",
    );
  }
  const limits = normalizeLimits(limitOverrides);
  const directory = await prepareStateDirectory(stateDir);
  const statePath = path.join(directory, "state.json");
  const eventPath = path.join(directory, "events.jsonl");
  const releaseLock = await holdOwnedFileLock({
    lockPath: path.join(directory, ".control-plane.lock"),
    busyCode: "COORDINATION_CONTROL_PLANE_ACTIVE",
    busyMessage:
      "Another coordination control-plane process owns this state directory.",
  });
  let state;
  try {
    const snapshotRaw = await readBoundedUtf8(
      statePath,
      LIMITS_DISTRIBUTED_V1.state.maxSnapshotBytes,
      { optional: true },
    );
    let snapshot = null;
    let snapshotError = null;
    if (snapshotRaw !== null) {
      try {
        snapshot = parseState(snapshotRaw);
      } catch (error) {
        snapshotError = error;
      }
    }
    if (
      snapshot &&
      stable(snapshot.limits) !== stable(limits)
    ) {
      fail(
        "COORDINATION_LIMIT_MISMATCH",
        "Configured distributed coordination limits do not match durable state.",
      );
    }
    const events = await readCoordinationEvents(eventPath, limits);
    const replayed = replayCoordinationEvents(events, limits);
    if (
      events.length === 0 &&
      snapshotError &&
      snapshotRaw !== null
    ) {
      throw snapshotError;
    }
    if (
      snapshot &&
      snapshot.sequence > replayed.sequence
    ) {
      fail(
        "COORDINATION_EVENT_LOG_MISSING",
        "Coordination snapshot is ahead of its write-ahead journal.",
      );
    }
    state = replayed;
    if (!snapshot || stable(snapshot) !== stable(replayed)) {
      await atomicStateWrite(statePath, replayed);
    }
  } catch (error) {
    await releaseLock();
    throw error;
  }
  let closed = false;
  let closePromise = null;
  let queue = Promise.resolve();
  let checkpointedSequence = state.sequence;

  const executeSerialized = async (request) => {
    validateRequest(request);
    if (QUERY_OPERATIONS.has(request.operation)) {
      return {
        sequence: state.sequence,
        idempotent: false,
        result: applyQuery(state, request),
      };
    }
    const requestDigest = digest({
      operation: request.operation,
      data: request.data,
    });
    const existing = ownValue(
      state.idempotencyRecords,
      request.idempotencyKey,
    );
    if (existing) {
      if (
        existing.operation !== request.operation ||
        existing.requestDigest !== requestDigest
      ) {
        fail(
          "COORDINATION_IDEMPOTENCY_CONFLICT",
          "Idempotency key was already used for a different coordination mutation.",
        );
      }
      return {
        sequence: existing.sequence,
        idempotent: true,
        result: structuredClone(existing.result),
      };
    }
    if (
      Object.keys(state.idempotencyRecords).length >=
      LIMITS_DISTRIBUTED_V1.state.maxIdempotencyRecords
    ) {
      fail(
        "COORDINATION_IDEMPOTENCY_CAPACITY",
        "Coordination idempotency capacity is exhausted; rotate the control-plane segment.",
      );
    }
    const observedNow = clock();
    if (!Number.isSafeInteger(observedNow) || observedNow < 0) {
      fail("COORDINATION_CLOCK_INVALID", "Control-plane clock is invalid.");
    }
    const nowMs = Math.max(state.logicalTimeMs, observedNow);
    const next = structuredClone(state);
    const assignments = [];
    const result = applyMutation(next, request, {
      nowMs,
      randomId: () => {
        const value = randomId();
        assignments.push(value);
        return value;
      },
    });
    next.sequence += 1;
    const unsignedEvent = {
      kind: "CODEX_CHAT_COORDINATION_EVENT_V1",
      protocolVersion: 1,
      sequence: next.sequence,
      atMs: nowMs,
      limitsDigest: digest(state.limits),
      request: structuredClone(request),
      assignments,
      resultDigest: digest(result),
      previousHash: state.lastEventHash,
    };
    const event = {
      ...unsignedEvent,
      hash: digest(unsignedEvent),
    };
    next.lastEventHash = event.hash;
    next.logicalTimeMs = nowMs;
    const idempotencyRecord = {
      operation: request.operation,
      requestDigest,
      result,
      sequence: next.sequence,
    };
    const idempotencyBytes = Buffer.byteLength(stable(idempotencyRecord));
    if (
      next.idempotencyBytes + idempotencyBytes >
      LIMITS_DISTRIBUTED_V1.state.maxIdempotencyBytes
    ) {
      fail(
        "COORDINATION_IDEMPOTENCY_CAPACITY",
        "Coordination idempotency byte capacity is exhausted; rotate the control-plane segment.",
      );
    }
    next.idempotencyRecords[request.idempotencyKey] = idempotencyRecord;
    next.idempotencyBytes += idempotencyBytes;
    await appendCoordinationEvent(eventPath, event);
    state = next;
    if (
      next.sequence %
        LIMITS_DISTRIBUTED_V1.state.checkpointEveryEvents ===
      0
    ) {
      await atomicStateWrite(statePath, next);
      checkpointedSequence = next.sequence;
    }
    return {
      sequence: next.sequence,
      idempotent: false,
      result: structuredClone(result),
    };
  };

  return {
    execute(request) {
      if (closed) {
        return Promise.resolve().then(() => {
          fail(
            "COORDINATION_CONTROL_PLANE_CLOSED",
            "Coordination control plane is closed.",
          );
        });
      }
      const operation = queue.then(
        () => executeSerialized(request),
        () => executeSerialized(request),
      );
      queue = operation.catch(() => {});
      return operation;
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        try {
          await queue;
          if (checkpointedSequence !== state.sequence) {
            await atomicStateWrite(statePath, state);
            checkpointedSequence = state.sequence;
          }
        } finally {
          await releaseLock();
        }
      })();
      return closePromise;
    },
  };
}
