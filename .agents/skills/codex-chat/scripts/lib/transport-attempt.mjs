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
import { egoBootstrapLease } from "./ego-bootstrap-lease.mjs";
import { decideEgoReadiness } from "./ego-readiness.mjs";
import { withOwnedFileLock } from "./file-lock.mjs";
import {
  inspectDesktopGeneration,
  transportGate,
} from "./transport-gate.mjs";

const RECORD_SCHEMA = "CODEX_CHAT_TRANSPORT_ATTEMPT_V1";
const RESULT_SCHEMA = "codex-chat/transport-attempt-result/v1";
const MAX_RECORD_BYTES = 32 * 1024;
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

function exactKeys(value, keys) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
}

function validText(value, maxLength = 256) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateOwner(owner) {
  if (
    !exactKeys(owner, OWNER_KEYS) ||
    OWNER_KEYS.some((key) => !validText(owner[key]))
  ) {
    fail(
      "TRANSPORT_ATTEMPT_OWNER_INVALID",
      "Transport attempt owner is malformed or contains unsupported fields.",
    );
  }
  return owner;
}

function validateAvailability(availability) {
  if (
    !exactKeys(availability, ["primary", "ego"]) ||
    typeof availability.primary !== "boolean" ||
    typeof availability.ego !== "boolean"
  ) {
    fail(
      "TRANSPORT_ATTEMPT_AVAILABILITY_INVALID",
      "Transport availability must explicitly describe primary and Ego adapters.",
    );
  }
  return availability;
}

function pathsFor(transportStateDir, attemptId) {
  const root = path.resolve(transportStateDir, "attempts");
  const key = sha256(attemptId);
  return {
    root,
    record: path.join(root, `${key}.json`),
    lock: path.join(root, `.${key}.lock`),
  };
}

async function prepareDirectory(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    fail(
      "TRANSPORT_ATTEMPT_DIRECTORY_INVALID",
      "Transport attempt directory must be a private real directory.",
    );
  }
  return realpath(root);
}

async function prepareTransportStateRoot(transportStateDir) {
  const root = path.resolve(transportStateDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    fail(
      "TRANSPORT_ATTEMPT_DIRECTORY_INVALID",
      "Transport state root must be a private real directory.",
    );
  }
  return realpath(root);
}

function ownerMatches(left, right) {
  return OWNER_KEYS.every((key) => left[key] === right[key]);
}

function validateRecord(record) {
  if (
    record?.schema !== RECORD_SCHEMA ||
    !exactKeys(record.owner, OWNER_KEYS) ||
    !exactKeys(record.availability, ["primary", "ego"]) ||
    ![
      "primary_probe_pending",
      "primary_readiness_pending",
      "ego_readiness_pending",
      "ready",
      "stopped",
    ].includes(record.phase) ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 1 ||
    ![1, 2].includes(record.primaryProbeNumber) ||
    !(
      record.phase === "primary_probe_pending"
        ? validText(record.primaryClaimToken, 128)
        : record.primaryClaimToken === null
    ) ||
    !(
      record.phase === "ego_readiness_pending"
        ? validText(record.egoLeaseId, 256) && validText(record.egoLeaseToken, 512)
        : record.egoLeaseId === null && record.egoLeaseToken === null
    ) ||
    !(
      record.phase === "ego_readiness_pending"
        ? (
            record.boundTargetId === null &&
            (
              (
                record.initialTargetId === null &&
                record.preservedDraftTargetId === null
              ) ||
              (
                validText(record.initialTargetId, 512) &&
                record.preservedDraftTargetId === record.initialTargetId
              )
            )
          )
        : record.phase === "ready"
          ? (
              validText(record.initialTargetId, 512) &&
              (
                record.preservedDraftTargetId === null ||
                record.preservedDraftTargetId === record.initialTargetId
              ) &&
              validText(record.boundTargetId, 512)
            )
          : record.phase === "stopped"
            ? (
                validText(record.initialTargetId, 512) &&
                (
                  record.preservedDraftTargetId === null ||
                  record.preservedDraftTargetId === record.initialTargetId
                ) &&
                record.boundTargetId === null &&
                validText(record.failureReason, 256)
              )
            : (
              record.initialTargetId === null &&
              record.preservedDraftTargetId === null &&
              record.boundTargetId === null
            )
    ) ||
    !(
      record.phase === "ready"
        ? validText(record.providerOrigin, 256) && validText(record.providerPath, 2048)
        : record.providerOrigin === null && record.providerPath === null
    ) ||
    !(
      record.phase === "ready"
        ? ["browser", "ego"].includes(record.adapter)
        : record.phase === "stopped"
          ? ["browser", "ego"].includes(record.adapter)
        : record.adapter === null
    ) ||
    !(
      record.phase === "ego_readiness_pending"
        ? (
            record.taskSpaceId === null ||
            (Number.isSafeInteger(record.taskSpaceId) && record.taskSpaceId > 0)
          )
        : record.phase === "ready" || record.phase === "stopped"
          ? (
              record.adapter === "ego"
                ? Number.isSafeInteger(record.taskSpaceId) && record.taskSpaceId > 0
                : record.taskSpaceId === null
            )
          : record.taskSpaceId === null
    )
  ) {
    fail(
      "TRANSPORT_ATTEMPT_STATE_INVALID",
      "Transport attempt state is malformed or unsupported.",
    );
  }
  validateOwner(record.owner);
  validateAvailability(record.availability);
  return record;
}

async function readRecord(filePath) {
  let pathInfo;
  try {
    pathInfo = await lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (
    !pathInfo.isFile() ||
    pathInfo.isSymbolicLink() ||
    pathInfo.size > MAX_RECORD_BYTES
  ) {
    fail(
      "TRANSPORT_ATTEMPT_STATE_INVALID",
      "Transport attempt state must be a bounded regular file.",
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
      descriptorInfo.dev !== pathInfo.dev ||
      descriptorInfo.ino !== pathInfo.ino ||
      descriptorInfo.size > MAX_RECORD_BYTES
    ) {
      fail(
        "TRANSPORT_ATTEMPT_STATE_INVALID",
        "Transport attempt state changed while it was being read.",
      );
    }
    const bytes = await handle.readFile();
    try {
      return validateRecord(JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ));
    } catch (error) {
      if (error?.code === "TRANSPORT_ATTEMPT_STATE_INVALID") throw error;
      fail(
        "TRANSPORT_ATTEMPT_STATE_INVALID",
        "Transport attempt state is not valid UTF-8 JSON.",
      );
    }
  } catch (error) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes(error.code)) {
      fail(
        "TRANSPORT_ATTEMPT_STATE_INVALID",
        "Transport attempt state changed while it was being read.",
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(filePath, record) {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, {
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

function primaryProbeResult(record, reason) {
  return {
    schema: RESULT_SCHEMA,
    attemptId: record.owner.attemptId,
    sequence: record.sequence,
    phase: record.phase,
    decision: "probe_primary",
    adapter: "browser",
    reason,
    primaryProbeNumber: record.primaryProbeNumber,
    rediscoveryRequired: record.primaryProbeNumber === 2,
    nextAction: record.primaryProbeNumber === 1
      ? "run_zero_io_probe"
      : "rediscover_then_run_zero_io_probe",
  };
}

function egoReadinessResult(record, reason) {
  return {
    schema: RESULT_SCHEMA,
    attemptId: record.owner.attemptId,
    sequence: record.sequence,
    phase: record.phase,
    decision: "observe_ego_initial",
    adapter: "ego",
    reason,
    taskSpaceId: record.taskSpaceId,
    preservedDraftTargetId: null,
    nextAction: "inspect_initial_target",
  };
}

function primaryReadinessResult(record) {
  return {
    schema: RESULT_SCHEMA,
    attemptId: record.owner.attemptId,
    sequence: record.sequence,
    phase: record.phase,
    decision: "observe_primary_page",
    adapter: "browser",
    reason: "primary_transport_ready",
    preservedDraftTargetId: null,
    nextAction: "inspect_initial_target",
  };
}

function egoFreshResult(record) {
  return {
    schema: RESULT_SCHEMA,
    attemptId: record.owner.attemptId,
    sequence: record.sequence,
    phase: record.phase,
    decision: "observe_ego_fresh",
    adapter: "ego",
    reason: "fresh_target_required",
    taskSpaceId: record.taskSpaceId,
    preservedDraftTargetId: record.preservedDraftTargetId,
    nextAction: "inspect_fresh_target",
  };
}

function readyResult(record) {
  return {
    schema: RESULT_SCHEMA,
    attemptId: record.owner.attemptId,
    sequence: record.sequence,
    phase: record.phase,
    decision: "ready",
    adapter: record.adapter,
    reason: record.adapter === "ego" ? "ego_ready" : "primary_ready",
    ...(record.adapter === "ego" ? { taskSpaceId: record.taskSpaceId } : {}),
    targetId: record.boundTargetId,
    preservedDraftTargetId: record.preservedDraftTargetId,
    providerOrigin: record.providerOrigin,
    providerPath: record.providerPath,
    nextAction: "prepare_capsule",
  };
}

function stoppedResult(record) {
  return {
    schema: RESULT_SCHEMA,
    attemptId: record.owner.attemptId,
    sequence: record.sequence,
    phase: record.phase,
    decision: "stop",
    adapter: record.adapter,
    reason: record.failureReason,
    ...(record.adapter === "ego" ? { taskSpaceId: record.taskSpaceId } : {}),
    targetId: null,
    preservedDraftTargetId: record.preservedDraftTargetId,
    nextAction: "preserve_draft_and_stop",
  };
}

function currentResult(record, reason = "attempt_resumed") {
  if (record.phase === "primary_probe_pending") {
    return primaryProbeResult(record, reason);
  }
  if (record.phase === "primary_readiness_pending") {
    return primaryReadinessResult(record);
  }
  if (record.phase === "ego_readiness_pending") {
    return record.preservedDraftTargetId === null
      ? egoReadinessResult(record, reason)
      : egoFreshResult(record);
  }
  if (record.phase === "ready") return readyResult(record);
  return stoppedResult(record);
}

async function acquireEgo({ transportStateDir, owner, dependencies }) {
  const lease = await egoBootstrapLease({
    action: "acquire",
    transportStateDir,
    owner,
    clock: dependencies.clock,
    createToken: dependencies.createEgoToken,
    createLeaseId: dependencies.createEgoLeaseId,
  });
  if (!lease.acquired || lease.leaseToken === null) {
    fail(
      "TRANSPORT_ATTEMPT_EGO_BUSY",
      `Ego bootstrap is unavailable: ${lease.reason}.`,
    );
  }
  return lease;
}

function initialRecord({
  owner,
  availability,
  phase,
  primaryClaimToken = null,
  lease = null,
}) {
  return {
    schema: RECORD_SCHEMA,
    owner: { ...owner },
    availability: { ...availability },
    sequence: 1,
    phase,
    primaryProbeNumber: 1,
    primaryClaimToken,
    egoLeaseId: lease?.leaseId ?? null,
    egoLeaseToken: lease?.leaseToken ?? null,
    initialTargetId: null,
    preservedDraftTargetId: null,
    boundTargetId: null,
    providerOrigin: null,
    providerPath: null,
    adapter: null,
    taskSpaceId: null,
  };
}

export async function advanceTransportAttempt({
  action,
  transportStateDir,
  owner,
  availability = null,
  observation = null,
  dependencies = {},
}) {
  validateOwner(owner);
  const canonicalTransportStateDir = await prepareTransportStateRoot(
    transportStateDir,
  );
  transportStateDir = canonicalTransportStateDir;
  const unresolvedPaths = pathsFor(
    canonicalTransportStateDir,
    owner.attemptId,
  );
  const canonicalRoot = await prepareDirectory(unresolvedPaths.root);
  const paths = {
    ...unresolvedPaths,
    root: canonicalRoot,
    record: path.join(canonicalRoot, path.basename(unresolvedPaths.record)),
    lock: path.join(canonicalRoot, path.basename(unresolvedPaths.lock)),
  };
  return withOwnedFileLock({
    lockPath: paths.lock,
    busyCode: "TRANSPORT_ATTEMPT_BUSY",
    busyMessage: "Another coordinator is advancing this transport attempt.",
  }, async () => {
    const current = await readRecord(paths.record);
    if (action === "start") {
      validateAvailability(availability);
      if (current !== null) {
        if (!ownerMatches(current.owner, owner)) {
          fail(
            "TRANSPORT_ATTEMPT_OWNER_MISMATCH",
            "Transport attempt is owned by a different immutable route.",
          );
        }
        return currentResult(current);
      }
      if (availability.primary !== true) {
        if (!availability.ego) {
          fail(
            "TRANSPORT_ATTEMPT_ADAPTERS_UNAVAILABLE",
            "Neither primary nor Ego transport is available.",
          );
        }
        const lease = await acquireEgo({ transportStateDir, owner, dependencies });
        const next = initialRecord({
          owner,
          availability,
          phase: "ego_readiness_pending",
          lease,
        });
        await atomicWrite(paths.record, next);
        return egoReadinessResult(next, "primary_unavailable");
      }
      const primaryClaimToken = dependencies.createToken?.() ?? randomUUID();
      if (!validText(primaryClaimToken, 128)) {
        fail(
          "TRANSPORT_ATTEMPT_TOKEN_INVALID",
          "Transport attempt capability is invalid.",
        );
      }
      const gate = await transportGate({
        action: "claim",
        transportStateDir,
        generationProvider: () => inspectDesktopGeneration({
          processTable: dependencies.processTable,
        }),
        clock: dependencies.clock,
        createToken: () => primaryClaimToken,
      });
      if (!gate.probeAllowed) {
        if (gate.reason === "probe_in_progress") {
          fail(
            "TRANSPORT_ATTEMPT_PRIMARY_BUSY",
            "Another coordinator owns the active primary transport probe.",
          );
        }
        if (!availability.ego) {
          fail(
            "TRANSPORT_ATTEMPT_PRIMARY_NOT_READY",
            `Primary transport probe was not allowed: ${gate.reason}.`,
          );
        }
        const lease = await acquireEgo({ transportStateDir, owner, dependencies });
        const next = initialRecord({
          owner,
          availability,
          phase: "ego_readiness_pending",
          lease,
        });
        await atomicWrite(paths.record, next);
        return egoReadinessResult(next, `primary_${gate.reason}`);
      }
      const next = initialRecord({
        owner,
        availability,
        phase: "primary_probe_pending",
        primaryClaimToken,
      });
      await atomicWrite(paths.record, next);
      return primaryProbeResult(next, gate.reason);
    }

    if (current === null) {
      fail(
        "TRANSPORT_ATTEMPT_NOT_FOUND",
        "Transport attempt has not been started.",
      );
    }
    if (!ownerMatches(current.owner, owner)) {
      fail(
        "TRANSPORT_ATTEMPT_OWNER_MISMATCH",
        "Transport attempt is owned by a different immutable route.",
      );
    }
    if (action === "status") return currentResult(current);
    if (action === "observe_primary") {
      if (
        current.phase !== "primary_probe_pending" ||
        !exactKeys(observation, ["outcome", "probeNumber"]) ||
        !["success", "transport_closed", "unavailable"].includes(observation.outcome) ||
        ![1, 2].includes(observation.probeNumber) ||
        observation.probeNumber !== current.primaryProbeNumber
      ) {
        fail(
          "TRANSPORT_ATTEMPT_OBSERVATION_INVALID",
          "Primary transport observation is malformed or unsupported.",
        );
      }
      if (observation.outcome === "unavailable") {
        await transportGate({
          action: "release",
          claimToken: current.primaryClaimToken,
          transportStateDir,
        });
        if (!current.availability.ego) {
          fail(
            "TRANSPORT_ATTEMPT_ADAPTERS_EXHAUSTED",
            "Primary transport is unavailable and the Ego fallback is unavailable.",
          );
        }
        const lease = await acquireEgo({ transportStateDir, owner, dependencies });
        const next = {
          ...current,
          sequence: current.sequence + 1,
          phase: "ego_readiness_pending",
          primaryClaimToken: null,
          egoLeaseId: lease.leaseId,
          egoLeaseToken: lease.leaseToken,
        };
        await atomicWrite(paths.record, next);
        return egoReadinessResult(next, "primary_unavailable");
      }
      if (observation.outcome === "success") {
        await transportGate({
          action: "success",
          claimToken: current.primaryClaimToken,
          transportStateDir,
          generationProvider: () => inspectDesktopGeneration({
            processTable: dependencies.processTable,
          }),
          clock: dependencies.clock,
        });
        const next = {
          ...current,
          sequence: current.sequence + 1,
          phase: "primary_readiness_pending",
          primaryClaimToken: null,
        };
        await atomicWrite(paths.record, next);
        return primaryReadinessResult(next);
      }
      if (current.primaryProbeNumber === 1) {
        const next = {
          ...current,
          sequence: current.sequence + 1,
          primaryProbeNumber: 2,
        };
        await atomicWrite(paths.record, next);
        return primaryProbeResult(next, "rediscovery_probe_required");
      }
      await transportGate({
        action: "failure",
        claimToken: current.primaryClaimToken,
        transportStateDir,
        generationProvider: () => inspectDesktopGeneration({
          processTable: dependencies.processTable,
        }),
        clock: dependencies.clock,
      });
      if (!current.availability.ego) {
        fail(
          "TRANSPORT_ATTEMPT_ADAPTERS_EXHAUSTED",
          "Primary transport closed and the Ego fallback is unavailable.",
        );
      }
      const lease = await acquireEgo({ transportStateDir, owner, dependencies });
      const next = {
        ...current,
        sequence: current.sequence + 1,
        phase: "ego_readiness_pending",
        primaryClaimToken: null,
        egoLeaseId: lease.leaseId,
        egoLeaseToken: lease.leaseToken,
      };
      await atomicWrite(paths.record, next);
      return egoReadinessResult(next, "primary_transport_closed");
    }
    if (action === "observe_ego") {
      if (
        current.phase !== "ego_readiness_pending" ||
        !exactKeys(observation, ["taskSpaceId", "candidateTargetId", "readiness"]) ||
        !Number.isSafeInteger(observation.taskSpaceId) ||
        observation.taskSpaceId < 1 ||
        !validText(observation.candidateTargetId, 512) ||
        (
          current.taskSpaceId !== null &&
          current.taskSpaceId !== observation.taskSpaceId
        )
      ) {
        fail(
          "TRANSPORT_ATTEMPT_OBSERVATION_INVALID",
          "Ego readiness observation is malformed or out of sequence.",
        );
      }
      const initial = current.initialTargetId === null;
      const readiness = decideEgoReadiness({
        stage: initial ? "initial" : "fresh",
        initialTargetId: initial
          ? observation.candidateTargetId
          : current.initialTargetId,
        candidateTargetId: observation.candidateTargetId,
        preservedDraftTargetId: initial
          ? null
          : current.preservedDraftTargetId,
        observation: observation.readiness,
      });
      if (readiness.decision === "ready") {
        await egoBootstrapLease({
          action: "release",
          transportStateDir,
          owner,
          leaseId: current.egoLeaseId,
          leaseToken: current.egoLeaseToken,
          clock: dependencies.clock,
        });
        const next = {
          ...current,
          sequence: current.sequence + 1,
          phase: "ready",
          egoLeaseId: null,
          egoLeaseToken: null,
          initialTargetId: current.initialTargetId ?? observation.candidateTargetId,
          boundTargetId: readiness.targetId,
          providerOrigin: readiness.providerOrigin,
          providerPath: readiness.providerPath,
          adapter: "ego",
          taskSpaceId: observation.taskSpaceId,
        };
        await atomicWrite(paths.record, next);
        return readyResult(next);
      }
      if (readiness.decision !== "fresh_target_required") {
        await egoBootstrapLease({
          action: "release",
          transportStateDir,
          owner,
          leaseId: current.egoLeaseId,
          leaseToken: current.egoLeaseToken,
          clock: dependencies.clock,
        });
        const next = {
          ...current,
          sequence: current.sequence + 1,
          phase: "stopped",
          egoLeaseId: null,
          egoLeaseToken: null,
          adapter: "ego",
          taskSpaceId: observation.taskSpaceId,
          failureReason: readiness.failureReason ?? readiness.decision,
        };
        await atomicWrite(paths.record, next);
        return stoppedResult(next);
      }
      const next = {
        ...current,
        sequence: current.sequence + 1,
        initialTargetId: observation.candidateTargetId,
        preservedDraftTargetId: readiness.preservedDraftTargetId,
        taskSpaceId: observation.taskSpaceId,
      };
      await atomicWrite(paths.record, next);
      return egoFreshResult(next);
    }
    if (action === "observe_primary_page") {
      if (
        current.phase !== "primary_readiness_pending" ||
        !exactKeys(observation, ["candidateTargetId", "readiness"]) ||
        !validText(observation.candidateTargetId, 512)
      ) {
        fail(
          "TRANSPORT_ATTEMPT_OBSERVATION_INVALID",
          "Primary readiness observation is malformed or out of sequence.",
        );
      }
      const readiness = decideEgoReadiness({
        stage: "initial",
        initialTargetId: observation.candidateTargetId,
        candidateTargetId: observation.candidateTargetId,
        preservedDraftTargetId: null,
        observation: observation.readiness,
      });
      if (readiness.decision !== "ready") {
        const next = {
          ...current,
          sequence: current.sequence + 1,
          phase: "stopped",
          initialTargetId: observation.candidateTargetId,
          preservedDraftTargetId: readiness.preservedDraftTargetId,
          adapter: "browser",
          failureReason: readiness.failureReason ?? readiness.decision,
        };
        await atomicWrite(paths.record, next);
        return stoppedResult(next);
      }
      const next = {
        ...current,
        sequence: current.sequence + 1,
        phase: "ready",
        initialTargetId: observation.candidateTargetId,
        boundTargetId: readiness.targetId,
        providerOrigin: readiness.providerOrigin,
        providerPath: readiness.providerPath,
        adapter: "browser",
      };
      await atomicWrite(paths.record, next);
      return readyResult(next);
    }
    fail(
      "TRANSPORT_ATTEMPT_ACTION_INVALID",
      "Transport attempt action is unsupported.",
    );
  });
}
