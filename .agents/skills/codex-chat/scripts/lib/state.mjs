import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fail } from "./errors.mjs";
import { LIMITS_V1 } from "./limits.mjs";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROUTING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL = new Set(["accepted", "blocked"]);
const OUTBOUND_EVENTS = new Set(["send_reserved", "send_confirmed"]);

const EVENT_STATES = Object.freeze({
  prepared: { from: [null], to: "prepared" },
  send_reserved: { from: ["prepared", "needs_revision"], to: "send_reserved" },
  send_confirmed: { from: ["send_reserved"], to: "send_confirmed" },
  send_ambiguous: { from: ["send_reserved"], to: "response_pending_unknown" },
  transport_disconnected: {
    from: ["send_confirmed", "response_pending_unknown"],
    to: "response_pending_unknown",
  },
  response_observed: {
    from: ["send_confirmed", "response_pending_unknown"],
    to: "response_pending_unknown",
  },
  response_terminal: {
    from: ["send_confirmed", "response_pending_unknown", "human_required"],
    to: "response_terminal",
  },
  provider_terminal_failure: {
    from: ["send_confirmed", "response_pending_unknown"],
    to: "blocked",
  },
  resource_observation: { from: ["*"], to: "=" },
  local_takeover: { from: ["*"], to: "=" },
  suspended_both_limited: {
    from: ["send_confirmed", "response_pending_unknown"],
    to: "response_pending_unknown",
  },
  review_started: { from: ["response_terminal"], to: "reviewing" },
  validation_started: { from: ["reviewing"], to: "validating" },
  verification_recorded: { from: ["validating"], to: "=" },
  needs_revision: { from: ["reviewing", "validating"], to: "needs_revision" },
  accepted: { from: ["validating"], to: "accepted" },
  blocked: { from: ["*"], to: "blocked" },
  human_required: { from: ["*"], to: "human_required" },
});

const NEXT_ACTION = Object.freeze({
  prepared: "reserve-send",
  send_reserved: "reconcile-marker-before-send",
  send_confirmed: "observe-only-do-not-resend",
  response_pending_unknown: "observe-and-reconcile-do-not-resend",
  response_terminal: "review-response",
  reviewing: "apply-to-explicit-scratch",
  validating: "run-required-gates",
  needs_revision: "prepare-bounded-correction",
  accepted: "complete",
  blocked: "report-blocker",
  human_required: "wait-for-human-auth-or-decision",
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

function digest(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function bytesDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validRoutingBase(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ["workspaceId", "coordinatorId", "workUnitId"].every((key) =>
      ROUTING_ID.test(value[key] ?? "")
    ) &&
    Object.keys(value).every((key) =>
      ["workspaceId", "coordinatorId", "workUnitId"].includes(key)
    )
  );
}

function routingMatches(expected, actual, { includeAgent = false } = {}) {
  if (!expected || !actual || typeof actual !== "object") return false;
  const keys = [
    "workspaceId",
    "coordinatorId",
    "workUnitId",
    ...(includeAgent ? ["agentId"] : []),
  ];
  return keys.every((key) => expected[key] === actual[key]);
}

function validateRunId(runId) {
  if (!RUN_ID.test(runId)) fail("RUN_ID_INVALID", `Invalid run id: ${runId}`);
}

export function statePaths(stateDir, runId) {
  validateRunId(runId);
  const directory = path.join(path.resolve(stateDir), runId);
  return {
    directory,
    state: path.join(directory, "state.json"),
    events: path.join(directory, "events.jsonl"),
    lock: path.join(directory, ".record.lock"),
    recoveryLock: path.join(directory, ".record.lock.recovery"),
  };
}

function observation(status, source = "initial") {
  return { status, source, observedAt: null, expiresAt: null };
}

function initialResources() {
  return {
    controller: observation("available", "local"),
    collaborator: observation("unknown"),
    transport: { ...observation("unknown"), lastError: null },
    externalModel: {
      ...observation("unverified"),
      visibleLabel: null,
      transport: null,
      backendIdentity: "unverified",
    },
    agenticPool: observation("unknown"),
    upload: observation("not_used"),
    apiBudget: observation("disabled_by_policy", "policy"),
  };
}

function mergeResources(current, update = {}, at) {
  const result = structuredClone(current);
  for (const [key, value] of Object.entries(update)) {
    if (!Object.hasOwn(result, key) || !value || typeof value !== "object") {
      fail("RESOURCE_INVALID", `Unknown or invalid resource update: ${key}`);
    }
    if (
      typeof value.status !== "string" ||
      typeof value.source !== "string" ||
      (value.observedAt !== undefined && typeof value.observedAt !== "string") ||
      (value.expiresAt !== undefined && value.expiresAt !== null && typeof value.expiresAt !== "string")
    ) {
      fail("RESOURCE_INVALID", `Resource update lacks status/source provenance: ${key}`);
    }
    if (key === "apiBudget" && value.status !== "disabled_by_policy") {
      fail("PAID_API_FORBIDDEN", "Paid API fallback is disabled by policy.");
    }
    if (key === "externalModel" && value.backendIdentity && value.backendIdentity !== "unverified") {
      fail("MODEL_IDENTITY_UNVERIFIED", "Browser UI cannot verify backend model identity.");
    }
    result[key] = {
      ...result[key],
      ...value,
      observedAt: value.observedAt ?? at,
      ...(key === "externalModel" ? { backendIdentity: "unverified" } : {}),
    };
  }
  return result;
}

async function atomicTextWrite(filePath, contents, mode = 0o600) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, { mode, flag: "wx" });
  const handle = await open(temporary, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  await chmod(filePath, mode);
  const directoryHandle = await open(path.dirname(filePath), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function atomicStateWrite(filePath, state) {
  await atomicTextWrite(filePath, `${stable(state)}\n`);
}

async function readJson(filePath) {
  const contents = await readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (contents === null) return null;
  try {
    return JSON.parse(contents);
  } catch {
    fail("STATE_CORRUPT", `Invalid JSON state: ${filePath}`);
  }
}

async function readEvents(filePath, { repairPartial = false } = {}) {
  let contents = await readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (!contents) return [];
  let lines = contents.split("\n");
  if (lines.at(-1) !== "") {
    if (!repairPartial) {
      fail("EVENT_LOG_PARTIAL", "Event log has an incomplete tail; retry through a locked writer.");
    }
    const partial = lines.pop();
    const complete = `${lines.join("\n")}\n`;
    const partialDigest = createHash("sha256").update(partial).digest("hex");
    const quarantine = path.join(
      path.dirname(filePath),
      `events.partial-${partialDigest}.bin`,
    );
    await writeFile(quarantine, partial, { mode: 0o600, flag: "wx" }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await atomicTextWrite(filePath, complete);
    contents = complete;
    lines = contents.split("\n");
  }
  lines.pop();
  const events = [];
  let previousHash = null;
  for (let index = 0; index < lines.length; index += 1) {
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch {
      fail("EVENT_LOG_CORRUPT", `Event ${index + 1} is not valid JSON.`);
    }
    const { hash, ...unsigned } = event;
    if (
      event.sequence !== index + 1 ||
      event.previousHash !== previousHash ||
      digest(unsigned) !== hash
    ) {
      fail("EVENT_HASH_INVALID", `Event hash chain is invalid at sequence ${index + 1}.`);
    }
    previousHash = hash;
    events.push(event);
  }
  return events;
}

function comparableState(state) {
  if (!state) return null;
  const { recoveredFromEvents: _ignored, ...rest } = state;
  return rest;
}

export async function loadRun({ stateDir, runId, repair = false }) {
  const paths = statePaths(stateDir, runId);
  const [state, events] = await Promise.all([
    readJson(paths.state),
    readEvents(paths.events, { repairPartial: repair }),
  ]);
  if (!state && events.length === 0) fail("RUN_NOT_FOUND", `Run does not exist: ${runId}`);
  if (state && state.schemaVersion !== 1) {
    fail("STATE_VERSION_UNSUPPORTED", `Unsupported state schema: ${state.schemaVersion}`);
  }
  const last = events.at(-1);
  if (!last) {
    fail("STATE_EVENT_MISMATCH", "State and event log do not agree.");
  }
  const authoritative = {
    ...last.snapshot,
    lastEventHash: last.hash,
  };
  const matches =
    stable(comparableState(state)) === stable(comparableState(authoritative));
  const derived = {
    ...authoritative,
    recoveredFromEvents: !matches,
  };
  if (repair && !matches) {
    await atomicStateWrite(paths.state, derived);
  }
  return derived;
}

async function acquireRecoveryLock(recoveryLockPath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  fail(
    "LOCK_RECOVERY_BUSY",
    "Lock recovery is busy or requires explicit repair after a recovery-writer crash.",
  );
}

async function withRecoveryLock(paths, operation) {
  const recovery = await acquireRecoveryLock(paths.recoveryLock);
  try {
    return await operation();
  } finally {
    await recovery.close();
    await rm(paths.recoveryLock, { force: true });
  }
}

async function removeOwnedLock(paths, expectedMetadata) {
  return withRecoveryLock(paths, async () => {
    const current = await readFile(paths.lock, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current === expectedMetadata) {
      await rm(paths.lock);
      return true;
    }
    return false;
  });
}

async function acquireLock(paths) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const handle = await open(paths.lock, "wx", 0o600);
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
        await removeOwnedLock(paths, metadata);
        throw error;
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const reclaimed = await withRecoveryLock(paths, async () => {
        const first = await readFile(paths.lock, "utf8").catch((readError) => {
          if (readError.code === "ENOENT") return null;
          throw readError;
        });
        if (!first) return true;
        let metadata = null;
        try {
          metadata = JSON.parse(first);
        } catch {
          metadata = null;
        }
        if (!Number.isInteger(metadata?.pid) || typeof metadata?.token !== "string") {
          return false;
        }
        let alive = true;
        try {
          process.kill(metadata.pid, 0);
        } catch (checkError) {
          alive = checkError.code !== "ESRCH";
        }
        if (alive) return false;
        const second = await readFile(paths.lock, "utf8").catch((readError) => {
          if (readError.code === "ENOENT") return null;
          throw readError;
        });
        if (second === first) {
          await rm(paths.lock);
          return true;
        }
        return false;
      });
      if (reclaimed) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  fail("RUN_LOCKED", "Another writer holds the run state lock.");
}

function assertTerminalResponseBinding(current, data) {
  if (
    typeof data.turnId !== "string" ||
    data.turnId !== current?.outbound?.turnId ||
    typeof data.terminalMarker !== "string" ||
    data.terminalMarker.length === 0 ||
    data.terminalMarker !== current?.outbound?.expectedTerminalMarker ||
    !/^[a-f0-9]{64}$/.test(data.responseSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(data.resultEnvelopeSha256 ?? "") ||
    typeof data.conversationIdentity !== "string" ||
    data.conversationIdentity !== current?.outbound?.conversationIdentity
  ) {
    fail(
      "TERMINAL_RESPONSE_INVALID",
      "response_terminal must bind the active turn, expected terminal marker, full response digest, result envelope digest, and conversation identity.",
    );
  }
  if (
    current?.routing &&
    (
      !routingMatches(current.outbound?.routing, data.routing, { includeAgent: true }) ||
      data.captureState !== "terminal" ||
      data.truncated !== false ||
      !/^[a-f0-9]{64}$/.test(data.captureSha256 ?? "") ||
      (
        current.outbound?.confirmationEvidence?.providerMessageFingerprint &&
        data.providerMessageFingerprint !==
          current.outbound.confirmationEvidence.providerMessageFingerprint
      )
    )
  ) {
    fail(
      "TERMINAL_RESPONSE_ROUTING_INVALID",
      "response_terminal must bind the routed work unit and a complete non-truncated terminal capture.",
    );
  }
}

async function validateVerificationReceipt(current, data) {
  if (
    !current?.routing ||
    !Array.isArray(current.requiredGates) ||
    typeof data.gateId !== "string" ||
    !current.requiredGates.includes(data.gateId) ||
    !path.isAbsolute(data.receiptPath ?? "") ||
    !/^[a-f0-9]{64}$/.test(data.receiptSha256 ?? "")
  ) {
    fail(
      "VERIFICATION_RECEIPT_INVALID",
      "verification_recorded requires a declared gate and an absolute digest-bound receipt.",
    );
  }
  const receiptBytes = await readFile(path.resolve(data.receiptPath)).catch((error) => {
    if (error.code === "ENOENT") {
      fail("VERIFICATION_RECEIPT_MISSING", "Verification receipt does not exist.");
    }
    throw error;
  });
  if (bytesDigest(receiptBytes) !== data.receiptSha256) {
    fail("VERIFICATION_RECEIPT_DIGEST_MISMATCH", "Verification receipt digest does not match.");
  }
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes);
  } catch {
    fail("VERIFICATION_RECEIPT_INVALID", "Verification receipt is not valid JSON.");
  }
  const { executionDigest, ...unsignedReceipt } = receipt ?? {};
  if (
    receipt?.kind !== "CODEX_CHAT_VERIFY_RECEIPT_V1" ||
    receipt.protocolVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(executionDigest ?? "") ||
    digest(unsignedReceipt) !== executionDigest ||
    receipt.classification !== "success" ||
    receipt.exitCode !== 0 ||
    receipt.signal !== null ||
    receipt.timedOut !== false ||
    receipt.outputLimited === true
  ) {
    fail(
      "VERIFICATION_UNSUCCESSFUL",
      "Verification receipt is invalid, failed, signaled, timed out, or output-limited.",
    );
  }
  const expectedRouting = {
    ...current.routing,
    agentId: current.outbound?.routing?.agentId,
  };
  const bindings = receipt.bindings;
  if (
    !routingMatches(expectedRouting, bindings, { includeAgent: true }) ||
    bindings.runId !== current.runId ||
    bindings.turnId !== current.outbound?.turnId ||
    bindings.contextSha256 !== current.outbound?.payloadSha256 ||
    bindings.gateId !== data.gateId ||
    !/^[a-f0-9]{64}$/.test(bindings.applicationKey ?? "") ||
    !/^[a-f0-9]{64}$/.test(bindings.postimageSha256 ?? "") ||
    path.resolve(receipt.sourceRoot ?? "") !==
      path.resolve(await realpath(current.sourceRoot))
  ) {
    fail(
      "VERIFICATION_BINDING_MISMATCH",
      "Verification receipt is not bound to the active routed work unit and artifact.",
    );
  }
  return {
    gateId: data.gateId,
    receiptPath: path.resolve(data.receiptPath),
    receiptSha256: data.receiptSha256,
    executionDigest,
    evidenceClass: receipt.evidenceClass,
    applicationKey: bindings.applicationKey,
    postimageSha256: bindings.postimageSha256,
  };
}

async function revalidateVerificationSet(current) {
  const records = current?.verifications ?? {};
  const required = current?.requiredGates ?? [];
  if (
    !current?.routing ||
    required.length === 0 ||
    required.some((gateId) => !records[gateId])
  ) {
    fail("VERIFICATION_REQUIRED", "All declared verification gates must be recorded before acceptance.");
  }
  const values = required.map((gateId) => records[gateId]);
  if (
    new Set(values.map(({ applicationKey }) => applicationKey)).size !== 1 ||
    new Set(values.map(({ postimageSha256 }) => postimageSha256)).size !== 1
  ) {
    fail("VERIFICATION_BINDING_MISMATCH", "Verification gates do not bind the same artifact.");
  }
  for (const record of values) {
    const revalidated = await validateVerificationReceipt(current, {
      gateId: record.gateId,
      receiptPath: record.receiptPath,
      receiptSha256: record.receiptSha256,
    });
    if (stable(revalidated) !== stable(record)) {
      fail(
        "VERIFICATION_BINDING_MISMATCH",
        "A recorded verification receipt no longer matches the active routed work unit.",
      );
    }
  }
  return digest(values);
}

function reduce(current, event, data, at) {
  const rule = EVENT_STATES[event];
  if (!rule) fail("EVENT_UNSUPPORTED", `Unsupported event type: ${event}`);
  const currentPhase = current?.phase ?? null;
  if (TERMINAL.has(currentPhase)) fail("RUN_TERMINAL", `Run is already terminal: ${currentPhase}`);
  if (!rule.from.includes("*") && !rule.from.includes(currentPhase)) {
    fail("INVALID_TRANSITION", `${event} is not allowed from ${currentPhase ?? "uninitialized"}.`);
  }
  if (!current && event !== "prepared") {
    fail("INVALID_TRANSITION", "A run must start with prepared.");
  }
  if (event === "resource_observation" && !data.resources) {
    fail("RESOURCE_INVALID", "resource_observation requires resources.");
  }
  if (
    event === "prepared" &&
    !/^[a-f0-9]{64}$/.test(data.contextSha256 ?? "")
  ) {
    fail("CONTEXT_DIGEST_INVALID", "prepared requires a context SHA-256 digest.");
  }
  if (event === "prepared" && !path.isAbsolute(data.sourceRoot ?? "")) {
    fail("SOURCE_ROOT_INVALID", "prepared requires an absolute sourceRoot.");
  }
  if (event === "prepared" && (data.routing !== undefined || data.requiredGates !== undefined)) {
    if (
      !validRoutingBase(data.routing) ||
      !Array.isArray(data.requiredGates) ||
      data.requiredGates.length === 0 ||
      data.requiredGates.length > 16 ||
      new Set(data.requiredGates).size !== data.requiredGates.length ||
      data.requiredGates.some((gateId) => !ROUTING_ID.test(gateId ?? ""))
    ) {
      fail(
        "ROUTING_INVALID",
        "Coordinated runs require immutable workspace/coordinator/work-unit IDs and unique required gates.",
      );
    }
  }
  if (event === "send_reserved") {
    if (
      typeof data.turnId !== "string" ||
      data.turnId.length === 0 ||
      typeof data.marker !== "string" ||
      data.marker.length === 0 ||
      typeof data.expectedTerminalMarker !== "string" ||
      data.expectedTerminalMarker.length === 0 ||
      !/^[a-f0-9]{64}$/.test(data.payloadSha256 ?? "") ||
      typeof data.conversationIdentity !== "string" ||
      data.conversationIdentity.length === 0
    ) {
      fail(
        "SEND_RESERVATION_INVALID",
        "send_reserved requires turnId, marker, expectedTerminalMarker, payloadSha256, and conversationIdentity.",
      );
    }
    if (current?.outboundMarkers?.includes(data.marker)) {
      fail("OUTBOUND_MARKER_REUSED", "Outbound visible markers are single-use within a run.");
    }
    if (
      currentPhase === "prepared" &&
      data.payloadSha256 !== current.contextSha256
    ) {
      fail(
        "SEND_CONTEXT_MISMATCH",
        "The first outbound payload must match the prepared context digest.",
      );
    }
    if (
      current?.routing &&
      (
        !routingMatches(current.routing, data.routing) ||
        !ROUTING_ID.test(data.routing?.agentId ?? "")
      )
    ) {
      fail(
        "ROUTING_MISMATCH",
        "send_reserved must bind the prepared coordinator/work-unit route and one agent.",
      );
    }
  }
  if (event === "response_terminal") assertTerminalResponseBinding(current, data);
  const phase = rule.to === "=" ? currentPhase : rule.to;
  const collaboration = {
    conversationUrl: current?.collaboration?.conversationUrl ?? null,
    outboundTurnId: current?.collaboration?.outboundTurnId ?? null,
    terminalMarker: current?.collaboration?.terminalMarker ?? null,
    responseBinding: current?.collaboration?.responseBinding ?? null,
  };
  if (event === "send_reserved") {
    collaboration.terminalMarker = null;
    collaboration.responseBinding = null;
  }
  if (event === "send_confirmed") {
    if (
      typeof data.turnId !== "string" ||
      data.turnId !== current?.outbound?.turnId
    ) {
      fail("SEND_CONFIRMATION_INVALID", "send_confirmed turnId must match the reservation.");
    }
    if (
      current?.routing &&
      (
        !routingMatches(current.outbound?.routing, data.routing, { includeAgent: true }) ||
        data.marker !== current.outbound.marker ||
        data.conversationIdentity !== current.outbound.conversationIdentity ||
        !ROUTING_ID.test(data.transportKind ?? "") ||
        !ROUTING_ID.test(data.confirmationEvidenceClass ?? "") ||
        typeof data.observedAt !== "string" ||
        Number.isNaN(Date.parse(data.observedAt)) ||
        !data.locator ||
        !ROUTING_ID.test(data.locator.type ?? "") ||
        typeof data.locator.value !== "string" ||
        data.locator.value.length === 0 ||
        (
          data.providerMessageFingerprint !== null &&
          !/^[a-f0-9]{64}$/.test(data.providerMessageFingerprint ?? "")
        )
      )
    ) {
      fail(
        "SEND_CONFIRMATION_EVIDENCE_INVALID",
        "send_confirmed must bind the reserved route, marker, conversation, transport, locator, and observation provenance.",
      );
    }
    collaboration.conversationUrl = data.conversationUrl ?? collaboration.conversationUrl;
    collaboration.outboundTurnId = data.turnId;
  }
  if (event === "response_terminal") {
    collaboration.conversationUrl = data.conversationUrl ?? collaboration.conversationUrl;
    collaboration.terminalMarker = data.terminalMarker;
    collaboration.responseBinding = {
      turnId: data.turnId,
      terminalMarker: data.terminalMarker,
      responseSha256: data.responseSha256,
      resultEnvelopeSha256: data.resultEnvelopeSha256,
      conversationIdentity: data.conversationIdentity,
    };
  }
  const outbound =
    event === "send_reserved"
      ? {
          turnId: data.turnId,
          marker: data.marker,
          expectedTerminalMarker: data.expectedTerminalMarker,
          payloadSha256: data.payloadSha256,
          conversationIdentity: data.conversationIdentity,
          routing: current?.routing
            ? { ...current.routing, agentId: data.routing.agentId }
            : null,
          confirmationEvidence: null,
          confirmed: false,
        }
      : event === "send_confirmed"
        ? {
            ...current.outbound,
            confirmed: true,
            confirmationEvidence: current?.routing
              ? {
                  marker: data.marker,
                  conversationIdentity: data.conversationIdentity,
                  transportKind: data.transportKind,
                  observedAt: data.observedAt,
                  confirmationEvidenceClass: data.confirmationEvidenceClass,
                  providerMessageFingerprint: data.providerMessageFingerprint,
                  locator: data.locator,
                }
              : null,
          }
        : current?.outbound ?? null;
  let resources = current?.resources ?? initialResources();
  if (event === "resource_observation") {
    resources = mergeResources(resources, data.resources, at);
  } else if (event === "transport_disconnected") {
    resources = mergeResources(resources, {
      transport: {
        status: "disconnected",
        source: data.source ?? "transport",
        observedAt: at,
        expiresAt: null,
        lastError: data.error ?? "disconnected",
      },
    }, at);
  }
  const suspended =
    event === "response_terminal"
      ? null
      : event === "suspended_both_limited"
      ? {
          code: "SUSPENDED_BOTH_LIMITED",
          resumeAfter: data.resumeAfter ?? null,
          reason: data.reason ?? "Controller and collaborator allowances are exhausted.",
        }
      : current?.suspended ?? null;
  const verifications =
    event === "send_reserved"
      ? {}
      : { ...(current?.verifications ?? {}) };
  if (event === "verification_recorded") {
    const existing = verifications[data.verification.gateId];
    if (existing && stable(existing) !== stable(data.verification)) {
      fail(
        "VERIFICATION_GATE_CONFLICT",
        `Verification gate already records different evidence: ${data.verification.gateId}`,
      );
    }
    verifications[data.verification.gateId] = data.verification;
  }
  return {
    phase,
    collaboration,
    outbound,
    resources,
    independenceDegraded:
      current?.independenceDegraded === true || event === "local_takeover",
    suspended,
    sourceRoot: current?.sourceRoot ?? data.sourceRoot ?? null,
    contextSha256: current?.contextSha256 ?? data.contextSha256 ?? null,
    routing: current?.routing ?? data.routing ?? null,
    requiredGates: current?.requiredGates ?? data.requiredGates ?? [],
    verifications,
    verificationSetSha256:
      event === "accepted"
        ? data.verificationSetSha256 ?? current?.verificationSetSha256 ?? null
        : event === "send_reserved"
          ? null
          : current?.verificationSetSha256 ?? null,
    nextAction: suspended ? "wait-until-resume-after-do-not-resend" : NEXT_ACTION[phase],
  };
}

export async function recordEvent({
  stateDir,
  runId,
  event,
  data = {},
  expectedSequence,
  expectedState,
  idempotencyKey = null,
  clock = () => new Date().toISOString(),
  crashAfterEvent = false,
}) {
  if (!event || typeof event !== "string") fail("EVENT_INVALID", "A non-empty event is required.");
  if (Buffer.byteLength(stable(data)) > LIMITS_V1.ledger.maxEventDataBytes) {
    fail(
      "EVENT_DATA_TOO_LARGE",
      `Event data exceeds ${LIMITS_V1.ledger.maxEventDataBytes} bytes.`,
    );
  }
  if (
    idempotencyKey !== null &&
    (typeof idempotencyKey !== "string" ||
      idempotencyKey.length === 0 ||
      Buffer.byteLength(idempotencyKey) > LIMITS_V1.ledger.maxIdempotencyKeyBytes)
  ) {
    fail("IDEMPOTENCY_KEY_INVALID", "Idempotency key is empty or too large.");
  }
  if (OUTBOUND_EVENTS.has(event) && idempotencyKey === null) {
    fail("OUTBOUND_IDEMPOTENCY_REQUIRED", `${event} requires an idempotency key.`);
  }
  if (!Number.isInteger(expectedSequence) || expectedSequence < 0) {
    fail("EXPECTED_SEQUENCE_REQUIRED", "expectedSequence must be a non-negative integer.");
  }
  const paths = statePaths(stateDir, runId);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  const lock = await acquireLock(paths);
  try {
    let current;
    try {
      current = await loadRun({ stateDir, runId, repair: true });
    } catch (error) {
      if (error.code !== "RUN_NOT_FOUND") throw error;
      current = null;
    }

    if (event === "verification_recorded") {
      const verification = await validateVerificationReceipt(current, data);
      data = { ...data, verification };
    }
    if (event === "accepted" && current?.routing) {
      data = {
        ...data,
        verificationSetSha256: await revalidateVerificationSet(current),
      };
    }

    if (current && idempotencyKey) {
      const recorded = current.idempotencyRecords?.[idempotencyKey];
      const requested = { event, dataDigest: digest(data) };
      if (recorded) {
        if (
          recorded.event === requested.event &&
          recorded.dataDigest === requested.dataDigest
        ) {
          return { state: current, idempotent: true };
        }
        fail(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was already used for a different event or payload.",
        );
      }
      if (
        current.idempotencyKeys.includes(idempotencyKey) ||
        current.outboundIdempotencyKeys?.includes(idempotencyKey)
      ) {
        fail(
          "IDEMPOTENCY_CONFLICT",
          "Legacy idempotency key cannot be safely rebound.",
        );
      }
    }
    if (
      (current?.eventCount ?? 0) !== expectedSequence ||
      (current?.phase ?? null) !== expectedState
    ) {
      fail("STATE_CONFLICT", "Expected sequence/state does not match durable state.", {
        actualSequence: current?.eventCount ?? 0,
        actualState: current?.phase ?? null,
      });
    }
    const at = clock();
    const reduced = reduce(current, event, data, at);
    const idempotencyKeys = [
      ...(current?.idempotencyKeys ?? []),
      ...(idempotencyKey ? [idempotencyKey] : []),
    ].slice(-LIMITS_V1.ledger.retainedIdempotencyKeys);
    const outboundIdempotencyKeys = [
      ...(current?.outboundIdempotencyKeys ?? []),
      ...(OUTBOUND_EVENTS.has(event) ? [idempotencyKey] : []),
    ];
    const idempotencyRecords = {
      ...(current?.idempotencyRecords ?? {}),
      ...(idempotencyKey
        ? {
            [idempotencyKey]: {
              event,
              dataDigest: digest(data),
              sequence: expectedSequence + 1,
            },
          }
        : {}),
    };
    const outboundMarkers = [
      ...(current?.outboundMarkers ?? []),
      ...(event === "send_reserved" ? [data.marker] : []),
    ];
    const snapshot = {
      schemaVersion: 1,
      protocolVersion: 1,
      runId,
      ...reduced,
      eventCount: expectedSequence + 1,
      idempotencyKeys,
      idempotencyRecords,
      outboundIdempotencyKeys,
      outboundMarkers,
      recoveredFromEvents: false,
      updatedAt: at,
    };
    const unsigned = {
      schemaVersion: 1,
      runId,
      sequence: snapshot.eventCount,
      at,
      event,
      from: current?.phase ?? null,
      to: snapshot.phase,
      data,
      idempotencyKey,
      previousHash: current?.lastEventHash ?? null,
      snapshot,
    };
    const hash = digest(unsigned);
    await appendFile(paths.events, `${stable({ ...unsigned, hash })}\n`, { mode: 0o600 });
    await chmod(paths.events, 0o600);
    const eventHandle = await open(paths.events, "r");
    try {
      await eventHandle.sync();
    } finally {
      await eventHandle.close();
    }
    if (crashAfterEvent) fail("SIMULATED_CRASH", "Simulated crash after durable event append.");
    const next = { ...snapshot, lastEventHash: hash };
    await atomicStateWrite(paths.state, next);
    return { state: next, idempotent: false };
  } finally {
    await lock.handle.close();
    await removeOwnedLock(paths, lock.metadata);
  }
}
