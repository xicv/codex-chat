import assert from "node:assert/strict";
import { symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  advanceTransportAttempt,
} from "../../.agents/skills/codex-chat/scripts/lib/transport-attempt.mjs";
import {
  inspectDesktopGeneration,
  transportGate,
} from "../../.agents/skills/codex-chat/scripts/lib/transport-gate.mjs";
import { tempDir } from "../helpers.mjs";

const PROCESS_TABLE = `
60953 Sun Aug  2 17:36:54 2026 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
64773 Sun Aug  2 17:43:41 2026 /Applications/ChatGPT.app/Contents/Frameworks/codex-code-mode-host
`;

const OWNER = Object.freeze({
  workspaceId: "workspace-a",
  coordinatorId: "coordinator-a",
  workUnitId: "stability-audit",
  agentId: "agent-a",
  attemptId: "attempt-a",
});

const EMPTY_EGO_OBSERVATION = Object.freeze({
  providerOrigin: "https://chatgpt.com",
  providerPath: "/",
  pageReady: true,
  composerReady: true,
  composerState: "empty",
  loginControlPresent: false,
  accountUiPresent: false,
  challengePresent: false,
});

test("a transport attempt owns the primary probe claim without exposing its capability", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-");

  const result = await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: OWNER,
    availability: { primary: true, ego: true },
    dependencies: {
      processTable: async () => PROCESS_TABLE,
      clock: () => new Date("2026-08-02T10:00:00.000Z"),
      createToken: () => "private-primary-claim",
    },
  });

  assert.deepEqual(result, {
    schema: "codex-chat/transport-attempt-result/v1",
    attemptId: "attempt-a",
    sequence: 1,
    phase: "primary_probe_pending",
    decision: "probe_primary",
    adapter: "browser",
    reason: "probe_claimed",
    primaryProbeNumber: 1,
    rediscoveryRequired: false,
    nextAction: "run_zero_io_probe",
  });
  assert.equal(JSON.stringify(result).includes("private-primary-claim"), false);
});

test("the first closed primary observation permits exactly one rediscovery probe", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-rediscover-");
  const dependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:01:00.000Z"),
    createToken: () => "private-rediscovery-claim",
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: OWNER,
    availability: { primary: true, ego: true },
    dependencies,
  });

  const result = await advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner: OWNER,
    observation: { outcome: "transport_closed", probeNumber: 1 },
    dependencies,
  });

  assert.deepEqual(result, {
    schema: "codex-chat/transport-attempt-result/v1",
    attemptId: "attempt-a",
    sequence: 2,
    phase: "primary_probe_pending",
    decision: "probe_primary",
    adapter: "browser",
    reason: "rediscovery_probe_required",
    primaryProbeNumber: 2,
    rediscoveryRequired: true,
    nextAction: "rediscover_then_run_zero_io_probe",
  });
  assert.equal(JSON.stringify(result).includes("private-rediscovery-claim"), false);

  await assert.rejects(
    advanceTransportAttempt({
      action: "observe_primary",
      transportStateDir,
      owner: OWNER,
      observation: { outcome: "transport_closed", probeNumber: 1 },
      dependencies,
    }),
    { code: "TRANSPORT_ATTEMPT_OBSERVATION_INVALID" },
  );
});

test("a second closed observation records the failure and hands off once to Ego", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-fallback-");
  const dependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:02:00.000Z"),
    createToken: () => "private-primary-fallback-claim",
    createEgoToken: () => "private-ego-bootstrap-token",
    createEgoLeaseId: () => "ego-lease-a",
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: OWNER,
    availability: { primary: true, ego: true },
    dependencies,
  });
  await advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner: OWNER,
    observation: { outcome: "transport_closed", probeNumber: 1 },
    dependencies,
  });

  const result = await advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner: OWNER,
    observation: { outcome: "transport_closed", probeNumber: 2 },
    dependencies,
  });

  assert.deepEqual(result, {
    schema: "codex-chat/transport-attempt-result/v1",
    attemptId: "attempt-a",
    sequence: 3,
    phase: "ego_readiness_pending",
    decision: "observe_ego_initial",
    adapter: "ego",
    reason: "primary_transport_closed",
    taskSpaceId: null,
    preservedDraftTargetId: null,
    nextAction: "inspect_initial_target",
  });
  assert.equal(JSON.stringify(result).includes("private-primary-fallback-claim"), false);
  assert.equal(JSON.stringify(result).includes("private-ego-bootstrap-token"), false);
});

test("a second closed primary observation durably stops when Ego is unavailable", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-exhausted-");
  const owner = { ...OWNER, attemptId: "attempt-exhausted" };
  const dependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:02:30.000Z"),
    createToken: () => "private-primary-exhausted-claim",
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner,
    availability: { primary: true, ego: false },
    dependencies,
  });
  await advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner,
    observation: { outcome: "transport_closed", probeNumber: 1 },
    dependencies,
  });

  const stopped = await advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner,
    observation: { outcome: "transport_closed", probeNumber: 2 },
    dependencies,
  });

  assert.deepEqual(stopped, {
    schema: "codex-chat/transport-attempt-result/v1",
    attemptId: "attempt-exhausted",
    sequence: 3,
    phase: "stopped",
    decision: "stop",
    adapter: "browser",
    reason: "primary_transport_closed_ego_unavailable",
    retryAfter: "2026-08-02T10:07:30.000Z",
    restartVerified: null,
    targetId: null,
    preservedDraftTargetId: null,
    nextAction: "report_exact_outcome_and_stop",
  });
  assert.deepEqual(
    await advanceTransportAttempt({
      action: "status",
      transportStateDir,
      owner,
    }),
    stopped,
  );
});

test("the attempt preserves an inherited Ego draft and requests one fresh target", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-draft-");
  const dependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:03:00.000Z"),
    createToken: () => "private-primary-draft-claim",
    createEgoToken: () => "private-ego-draft-token",
    createEgoLeaseId: () => "ego-lease-draft",
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: OWNER,
    availability: { primary: true, ego: true },
    dependencies,
  });
  for (let index = 0; index < 2; index += 1) {
    await advanceTransportAttempt({
      action: "observe_primary",
      transportStateDir,
      owner: OWNER,
      observation: { outcome: "transport_closed", probeNumber: index + 1 },
      dependencies,
    });
  }

  const result = await advanceTransportAttempt({
    action: "observe_ego",
    transportStateDir,
    owner: OWNER,
    observation: {
      taskSpaceId: 7,
      candidateTargetId: "target-with-draft",
      readiness: {
        ...EMPTY_EGO_OBSERVATION,
        composerState: "nonempty",
      },
    },
    dependencies,
  });

  assert.deepEqual(result, {
    schema: "codex-chat/transport-attempt-result/v1",
    attemptId: "attempt-a",
    sequence: 4,
    phase: "ego_readiness_pending",
    decision: "observe_ego_fresh",
    adapter: "ego",
    reason: "fresh_target_required",
    taskSpaceId: 7,
    preservedDraftTargetId: "target-with-draft",
    nextAction: "inspect_fresh_target",
  });
  assert.equal(JSON.stringify(result).includes("private-ego-draft-token"), false);
});

test("a distinct empty Ego target becomes the only ready binding", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-ready-");
  const dependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:04:00.000Z"),
    createToken: () => "private-primary-ready-claim",
    createEgoToken: () => "private-ego-ready-token",
    createEgoLeaseId: () => "ego-lease-ready",
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: OWNER,
    availability: { primary: true, ego: true },
    dependencies,
  });
  for (let index = 0; index < 2; index += 1) {
    await advanceTransportAttempt({
      action: "observe_primary",
      transportStateDir,
      owner: OWNER,
      observation: { outcome: "transport_closed", probeNumber: index + 1 },
      dependencies,
    });
  }
  await advanceTransportAttempt({
    action: "observe_ego",
    transportStateDir,
    owner: OWNER,
    observation: {
      taskSpaceId: 7,
      candidateTargetId: "target-with-draft",
      readiness: {
        ...EMPTY_EGO_OBSERVATION,
        composerState: "nonempty",
      },
    },
    dependencies,
  });

  const result = await advanceTransportAttempt({
    action: "observe_ego",
    transportStateDir,
    owner: OWNER,
    observation: {
      taskSpaceId: 7,
      candidateTargetId: "target-fresh",
      readiness: EMPTY_EGO_OBSERVATION,
    },
    dependencies,
  });

  assert.deepEqual(result, {
    schema: "codex-chat/transport-attempt-result/v1",
    attemptId: "attempt-a",
    sequence: 5,
    phase: "ready",
    decision: "ready",
    adapter: "ego",
    reason: "ego_ready",
    taskSpaceId: 7,
    targetId: "target-fresh",
    preservedDraftTargetId: "target-with-draft",
    providerOrigin: "https://chatgpt.com",
    providerPath: "/",
    nextAction: "prepare_capsule",
  });
  assert.equal(JSON.stringify(result).includes("private-ego-ready-token"), false);
});

test("a successful zero-I/O probe advances to bounded primary-page readiness", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-primary-ready-");
  const dependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:05:00.000Z"),
    createToken: () => "private-primary-success-claim",
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: OWNER,
    availability: { primary: true, ego: true },
    dependencies,
  });

  const result = await advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner: OWNER,
    observation: { outcome: "success", probeNumber: 1 },
    dependencies,
  });

  assert.deepEqual(result, {
    schema: "codex-chat/transport-attempt-result/v1",
    attemptId: "attempt-a",
    sequence: 2,
    phase: "primary_readiness_pending",
    decision: "observe_primary_page",
    adapter: "browser",
    reason: "primary_transport_ready",
    preservedDraftTargetId: null,
    nextAction: "inspect_initial_target",
  });
  assert.equal(JSON.stringify(result).includes("private-primary-success-claim"), false);
});

test("a ready primary page becomes a bound Browser transport", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-browser-bound-");
  const dependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:06:00.000Z"),
    createToken: () => "private-primary-bound-claim",
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: OWNER,
    availability: { primary: true, ego: true },
    dependencies,
  });
  await advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner: OWNER,
    observation: { outcome: "success", probeNumber: 1 },
    dependencies,
  });

  const result = await advanceTransportAttempt({
    action: "observe_primary_page",
    transportStateDir,
    owner: OWNER,
    observation: {
      candidateTargetId: "browser-target",
      readiness: EMPTY_EGO_OBSERVATION,
    },
    dependencies,
  });

  assert.deepEqual(result, {
    schema: "codex-chat/transport-attempt-result/v1",
    attemptId: "attempt-a",
    sequence: 3,
    phase: "ready",
    decision: "ready",
    adapter: "browser",
    reason: "primary_ready",
    targetId: "browser-target",
    preservedDraftTargetId: null,
    providerOrigin: "https://chatgpt.com",
    providerPath: "/",
    nextAction: "prepare_capsule",
  });
});

test("an unsafe primary provider page stops durably without Ego fallback", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-browser-stop-");
  const dependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:06:30.000Z"),
    createToken: () => "private-primary-provider-stop-claim",
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: OWNER,
    availability: { primary: true, ego: true },
    dependencies,
  });
  await advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner: OWNER,
    observation: { outcome: "success", probeNumber: 1 },
    dependencies,
  });

  const stopped = await advanceTransportAttempt({
    action: "observe_primary_page",
    transportStateDir,
    owner: OWNER,
    observation: {
      candidateTargetId: "browser-target-with-draft",
      readiness: { ...EMPTY_EGO_OBSERVATION, composerState: "nonempty" },
    },
    dependencies,
  });

  assert.deepEqual(stopped, {
    schema: "codex-chat/transport-attempt-result/v1",
    attemptId: "attempt-a",
    sequence: 3,
    phase: "stopped",
    decision: "stop",
    adapter: "browser",
    reason: "fresh_target_required",
    targetId: null,
    preservedDraftTargetId: "browser-target-with-draft",
    nextAction: "preserve_draft_and_stop",
  });
  assert.deepEqual(
    await advanceTransportAttempt({
      action: "status",
      transportStateDir,
      owner: OWNER,
    }),
    stopped,
  );
});

test("an unavailable primary adapter hands off directly to one Ego bootstrap", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-ego-direct-");
  const result = await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: OWNER,
    availability: { primary: false, ego: true },
    dependencies: {
      clock: () => new Date("2026-08-02T10:07:00.000Z"),
      createEgoToken: () => "private-ego-direct-token",
      createEgoLeaseId: () => "ego-lease-direct",
    },
  });

  assert.deepEqual(result, {
    schema: "codex-chat/transport-attempt-result/v1",
    attemptId: "attempt-a",
    sequence: 1,
    phase: "ego_readiness_pending",
    decision: "observe_ego_initial",
    adapter: "ego",
    reason: "primary_unavailable",
    taskSpaceId: null,
    preservedDraftTargetId: null,
    nextAction: "inspect_initial_target",
  });
  assert.equal(JSON.stringify(result).includes("private-ego-direct-token"), false);
});

test("an active Ego bootstrap owner durably stops a competing attempt", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-ego-busy-");
  const dependencies = {
    clock: () => new Date("2026-08-02T10:07:15.000Z"),
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: { ...OWNER, attemptId: "attempt-ego-owner" },
    availability: { primary: false, ego: true },
    dependencies: {
      ...dependencies,
      createEgoToken: () => "private-ego-owner-token",
      createEgoLeaseId: () => "ego-owner-lease",
    },
  });
  const contenderOwner = {
    ...OWNER,
    coordinatorId: "coordinator-b",
    attemptId: "attempt-ego-contender",
  };

  const stopped = await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: contenderOwner,
    availability: { primary: false, ego: true },
    dependencies: {
      ...dependencies,
      createEgoToken: () => "private-ego-contender-token",
      createEgoLeaseId: () => "ego-contender-lease",
    },
  });

  assert.deepEqual(stopped, {
    schema: "codex-chat/transport-attempt-result/v1",
    attemptId: "attempt-ego-contender",
    sequence: 2,
    phase: "stopped",
    decision: "stop",
    adapter: "ego",
    reason: "ego_bootstrap_in_progress",
    taskSpaceId: null,
    retryAfter: "2026-08-02T10:22:15.000Z",
    restartVerified: null,
    targetId: null,
    preservedDraftTargetId: null,
    nextAction: "report_exact_outcome_and_stop",
  });
  assert.deepEqual(
    await advanceTransportAttempt({
      action: "status",
      transportStateDir,
      owner: contenderOwner,
    }),
    stopped,
  );
});

test("an attempt with neither adapter records a durable pre-egress stop", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-no-adapters-");
  const owner = { ...OWNER, attemptId: "attempt-no-adapters" };

  const stopped = await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner,
    availability: { primary: false, ego: false },
  });

  assert.deepEqual(stopped, {
    schema: "codex-chat/transport-attempt-result/v1",
    attemptId: "attempt-no-adapters",
    sequence: 1,
    phase: "stopped",
    decision: "stop",
    adapter: null,
    reason: "primary_and_ego_unavailable",
    retryAfter: null,
    restartVerified: null,
    targetId: null,
    preservedDraftTargetId: null,
    nextAction: "report_exact_outcome_and_stop",
  });
  assert.deepEqual(
    await advanceTransportAttempt({
      action: "status",
      transportStateDir,
      owner,
    }),
    stopped,
  );
});

test("an unavailable primary observation stops durably without Ego", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-tool-exhausted-");
  const owner = { ...OWNER, attemptId: "attempt-tool-exhausted" };
  const dependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:07:30.000Z"),
    createToken: () => "private-primary-tool-exhausted-claim",
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner,
    availability: { primary: true, ego: false },
    dependencies,
  });

  const stopped = await advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner,
    observation: { outcome: "unavailable", probeNumber: 1 },
    dependencies,
  });

  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.reason, "primary_unavailable_ego_unavailable");
  assert.equal(stopped.nextAction, "report_exact_outcome_and_stop");
  assert.deepEqual(
    await advanceTransportAttempt({
      action: "status",
      transportStateDir,
      owner,
    }),
    stopped,
  );
});

test("an unsafe fresh Ego target releases the lease and stops without touching the draft", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-stop-");
  const dependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:08:00.000Z"),
    createToken: () => "private-primary-stop-claim",
    createEgoToken: () => "private-ego-stop-token",
    createEgoLeaseId: () => "ego-lease-stop",
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: OWNER,
    availability: { primary: true, ego: true },
    dependencies,
  });
  for (let index = 0; index < 2; index += 1) {
    await advanceTransportAttempt({
      action: "observe_primary",
      transportStateDir,
      owner: OWNER,
      observation: { outcome: "transport_closed", probeNumber: index + 1 },
      dependencies,
    });
  }
  await advanceTransportAttempt({
    action: "observe_ego",
    transportStateDir,
    owner: OWNER,
    observation: {
      taskSpaceId: 8,
      candidateTargetId: "target-with-draft",
      readiness: { ...EMPTY_EGO_OBSERVATION, composerState: "nonempty" },
    },
    dependencies,
  });

  const result = await advanceTransportAttempt({
    action: "observe_ego",
    transportStateDir,
    owner: OWNER,
    observation: {
      taskSpaceId: 8,
      candidateTargetId: "target-fresh-but-nonempty",
      readiness: { ...EMPTY_EGO_OBSERVATION, composerState: "nonempty" },
    },
    dependencies,
  });

  assert.deepEqual(result, {
    schema: "codex-chat/transport-attempt-result/v1",
    attemptId: "attempt-a",
    sequence: 5,
    phase: "stopped",
    decision: "stop",
    adapter: "ego",
    reason: "fresh_target_not_ready_and_empty",
    taskSpaceId: 8,
    targetId: null,
    preservedDraftTargetId: "target-with-draft",
    nextAction: "preserve_draft_and_stop",
  });
  assert.equal(JSON.stringify(result).includes("private-ego-stop-token"), false);
});

test("status resumes a terminal binding without re-running either adapter", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-status-");
  const dependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:09:00.000Z"),
    createToken: () => "private-primary-status-claim",
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: OWNER,
    availability: { primary: true, ego: false },
    dependencies,
  });
  await advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner: OWNER,
    observation: { outcome: "success", probeNumber: 1 },
    dependencies,
  });
  const ready = await advanceTransportAttempt({
    action: "observe_primary_page",
    transportStateDir,
    owner: OWNER,
    observation: {
      candidateTargetId: "browser-target",
      readiness: EMPTY_EGO_OBSERVATION,
    },
    dependencies,
  });

  const resumed = await advanceTransportAttempt({
    action: "status",
    transportStateDir,
    owner: OWNER,
  });

  assert.deepEqual(resumed, ready);
  assert.equal(JSON.stringify(resumed).includes("private-primary-status-claim"), false);
});

test("an open same-host breaker selects Ego without probing Browser again", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-cooldown-");
  const generationProvider = () => inspectDesktopGeneration({
    processTable: async () => PROCESS_TABLE,
  });
  const claimed = await transportGate({
    action: "claim",
    transportStateDir,
    generationProvider,
    clock: () => new Date("2026-08-02T10:10:00.000Z"),
    createToken: () => "prior-transport-claim",
  });
  await transportGate({
    action: "failure",
    claimToken: claimed.claimToken,
    transportStateDir,
    generationProvider,
    clock: () => new Date("2026-08-02T10:10:01.000Z"),
  });

  const result = await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: { ...OWNER, attemptId: "attempt-cooldown" },
    availability: { primary: true, ego: true },
    dependencies: {
      processTable: async () => PROCESS_TABLE,
      clock: () => new Date("2026-08-02T10:10:02.000Z"),
      createToken: () => "must-not-be-returned",
      createEgoToken: () => "private-ego-cooldown-token",
      createEgoLeaseId: () => "ego-lease-cooldown",
    },
  });

  assert.equal(result.decision, "observe_ego_initial");
  assert.equal(result.reason, "primary_same_host_cooldown_active");
  assert.equal(result.sequence, 1);
});

test("an open same-host breaker records its exact retry when Ego is unavailable", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-cooldown-stop-");
  const generationProvider = () => inspectDesktopGeneration({
    processTable: async () => PROCESS_TABLE,
  });
  const claimed = await transportGate({
    action: "claim",
    transportStateDir,
    generationProvider,
    clock: () => new Date("2026-08-02T10:10:00.000Z"),
    createToken: () => "prior-transport-stop-claim",
  });
  await transportGate({
    action: "failure",
    claimToken: claimed.claimToken,
    transportStateDir,
    generationProvider,
    clock: () => new Date("2026-08-02T10:10:01.000Z"),
  });

  const stopped = await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: { ...OWNER, attemptId: "attempt-cooldown-stop" },
    availability: { primary: true, ego: false },
    dependencies: {
      processTable: async () => PROCESS_TABLE,
      clock: () => new Date("2026-08-02T10:10:02.000Z"),
      createToken: () => "unused-cooldown-stop-token",
    },
  });

  assert.equal(stopped.phase, "stopped");
  assert.equal(
    stopped.reason,
    "primary_same_host_cooldown_active_ego_unavailable",
  );
  assert.equal(stopped.retryAfter, "2026-08-02T10:15:01.000Z");
  assert.equal(stopped.restartVerified, false);
});

test("a primary probe owned by another coordinator durably stops the contender", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-primary-busy-");
  const dependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:10:30.000Z"),
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: { ...OWNER, attemptId: "attempt-primary-owner" },
    availability: { primary: true, ego: true },
    dependencies: {
      ...dependencies,
      createToken: () => "active-primary-owner-token",
    },
  });

  const contenderOwner = {
    ...OWNER,
    attemptId: "attempt-primary-contender",
  };
  const stopped = await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: contenderOwner,
    availability: { primary: true, ego: true },
    dependencies: {
      ...dependencies,
      createToken: () => "unused-contender-token",
      createEgoToken: () => "must-not-acquire-ego",
      createEgoLeaseId: () => "must-not-create-ego-lease",
    },
  });

  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.reason, "primary_probe_in_progress");
  assert.equal(stopped.retryAfter, "2026-08-02T10:12:30.000Z");
  assert.equal(stopped.nextAction, "report_exact_outcome_and_stop");
  assert.deepEqual(
    await advanceTransportAttempt({
      action: "status",
      transportStateDir,
      owner: contenderOwner,
    }),
    stopped,
  );
});

test("a missing primary tool neutrally releases its claim before Ego fallback", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-tool-missing-");
  const dependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:11:00.000Z"),
    createToken: () => "private-primary-missing-claim",
    createEgoToken: () => "private-ego-missing-token",
    createEgoLeaseId: () => "ego-lease-missing",
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: { ...OWNER, attemptId: "attempt-tool-missing" },
    availability: { primary: true, ego: true },
    dependencies,
  });

  const result = await advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner: { ...OWNER, attemptId: "attempt-tool-missing" },
    observation: { outcome: "unavailable", probeNumber: 1 },
    dependencies,
  });

  assert.equal(result.decision, "observe_ego_initial");
  assert.equal(result.reason, "primary_unavailable");
  const gate = await transportGate({
    action: "claim",
    transportStateDir,
    generationProvider: () => inspectDesktopGeneration({
      processTable: async () => PROCESS_TABLE,
    }),
    clock: () => new Date("2026-08-02T10:11:01.000Z"),
    createToken: () => "later-gate-claim",
  });
  assert.equal(gate.probeAllowed, true);
});

test("a primary success resumes after the gate commits but the attempt write crashes", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-primary-crash-");
  const baseDependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:12:00.000Z"),
    createToken: () => "private-primary-crash-claim",
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: { ...OWNER, attemptId: "attempt-primary-crash" },
    availability: { primary: true, ego: false },
    dependencies: baseDependencies,
  });

  await assert.rejects(
    advanceTransportAttempt({
      action: "observe_primary",
      transportStateDir,
      owner: { ...OWNER, attemptId: "attempt-primary-crash" },
      observation: { outcome: "success", probeNumber: 1 },
      dependencies: {
        ...baseDependencies,
        afterSideEffect: (kind) => {
          if (kind === "gate_success") throw new Error("SIMULATED_CRASH");
        },
      },
    }),
    /SIMULATED_CRASH/u,
  );

  const resumed = await advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner: { ...OWNER, attemptId: "attempt-primary-crash" },
    observation: { outcome: "success", probeNumber: 1 },
    dependencies: baseDependencies,
  });
  assert.equal(resumed.phase, "primary_readiness_pending");
  assert.equal(resumed.sequence, 2);
});

test("a primary claim resumes after the gate commits but the initial attempt write crashes", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-primary-claim-crash-");
  const owner = { ...OWNER, attemptId: "attempt-primary-claim-crash" };
  const baseDependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:12:30.000Z"),
    createToken: () => "private-primary-claim-crash-token",
  };

  await assert.rejects(advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner,
    availability: { primary: true, ego: true },
    dependencies: {
      ...baseDependencies,
      afterSideEffect: (kind) => {
        if (kind === "gate_claim") throw new Error("SIMULATED_CRASH");
      },
    },
  }), /SIMULATED_CRASH/u);

  await assert.rejects(advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner,
    observation: { outcome: "unavailable", probeNumber: 2 },
    dependencies: baseDependencies,
  }), { code: "TRANSPORT_ATTEMPT_RECOVERY_REQUIRED" });

  const resumed = await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner,
    availability: { primary: true, ego: true },
    dependencies: baseDependencies,
  });
  assert.equal(resumed.phase, "primary_probe_pending");
  assert.equal(resumed.primaryProbeNumber, 1);
});

test("an Ego fallback acquisition resumes after gate failure and lease commit crashes", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-fallback-crash-");
  const owner = { ...OWNER, attemptId: "attempt-fallback-crash" };
  const baseDependencies = {
    processTable: async () => PROCESS_TABLE,
    clock: () => new Date("2026-08-02T10:12:45.000Z"),
    createToken: () => "private-fallback-crash-claim",
    createEgoToken: () => "private-fallback-crash-ego-token",
    createEgoLeaseId: () => "fallback-crash-ego-lease",
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner,
    availability: { primary: true, ego: true },
    dependencies: baseDependencies,
  });
  await advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner,
    observation: { outcome: "transport_closed", probeNumber: 1 },
    dependencies: baseDependencies,
  });
  const secondFailure = { outcome: "transport_closed", probeNumber: 2 };

  await assert.rejects(advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner,
    observation: secondFailure,
    dependencies: {
      ...baseDependencies,
      afterSideEffect: (kind) => {
        if (kind === "ego_acquire") throw new Error("SIMULATED_CRASH");
      },
    },
  }), /SIMULATED_CRASH/u);

  await assert.rejects(advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner,
    observation: { outcome: "unavailable", probeNumber: 2 },
    dependencies: baseDependencies,
  }), { code: "TRANSPORT_ATTEMPT_RECOVERY_REQUIRED" });

  const resumed = await advanceTransportAttempt({
    action: "observe_primary",
    transportStateDir,
    owner,
    observation: secondFailure,
    dependencies: baseDependencies,
  });
  assert.equal(resumed.phase, "ego_readiness_pending");
  assert.equal(resumed.sequence, 3);
});

test("an Ego acquisition resumes after the lease commits but the attempt write crashes", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-ego-acquire-crash-");
  const baseDependencies = {
    clock: () => new Date("2026-08-02T10:13:00.000Z"),
    createEgoToken: () => "private-ego-acquire-crash-token",
    createEgoLeaseId: () => "ego-acquire-crash-lease",
  };

  await assert.rejects(
    advanceTransportAttempt({
      action: "start",
      transportStateDir,
      owner: { ...OWNER, attemptId: "attempt-ego-acquire-crash" },
      availability: { primary: false, ego: true },
      dependencies: {
        ...baseDependencies,
        afterSideEffect: (kind) => {
          if (kind === "ego_acquire") throw new Error("SIMULATED_CRASH");
        },
      },
    }),
    /SIMULATED_CRASH/u,
  );

  const resumed = await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner: { ...OWNER, attemptId: "attempt-ego-acquire-crash" },
    availability: { primary: false, ego: true },
    dependencies: baseDependencies,
  });
  assert.equal(resumed.phase, "ego_readiness_pending");
  assert.equal(resumed.sequence, 1);
});

test("an Ego release resumes after the lease commits but the terminal attempt write crashes", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-ego-release-crash-");
  const owner = { ...OWNER, attemptId: "attempt-ego-release-crash" };
  const baseDependencies = {
    clock: () => new Date("2026-08-02T10:14:00.000Z"),
    createEgoToken: () => "private-ego-release-crash-token",
    createEgoLeaseId: () => "ego-release-crash-lease",
  };
  await advanceTransportAttempt({
    action: "start",
    transportStateDir,
    owner,
    availability: { primary: false, ego: true },
    dependencies: baseDependencies,
  });
  const observation = {
    taskSpaceId: 9,
    candidateTargetId: "ego-crash-target",
    readiness: EMPTY_EGO_OBSERVATION,
  };

  await assert.rejects(
    advanceTransportAttempt({
      action: "observe_ego",
      transportStateDir,
      owner,
      observation,
      dependencies: {
        ...baseDependencies,
        afterSideEffect: (kind) => {
          if (kind === "ego_release") throw new Error("SIMULATED_CRASH");
        },
      },
    }),
    /SIMULATED_CRASH/u,
  );

  const resumed = await advanceTransportAttempt({
    action: "observe_ego",
    transportStateDir,
    owner,
    observation,
    dependencies: baseDependencies,
  });
  assert.equal(resumed.phase, "ready");
  assert.equal(resumed.targetId, "ego-crash-target");
  assert.equal(resumed.sequence, 2);
});

test("transport attempts reject a symlinked transport-state root", async () => {
  const realState = await tempDir("codex-chat-attempt-real-state-");
  const parent = await tempDir("codex-chat-attempt-linked-state-");
  const linkedState = path.join(parent, "transport");
  await symlink(realState, linkedState);

  await assert.rejects(
    advanceTransportAttempt({
      action: "start",
      transportStateDir: linkedState,
      owner: OWNER,
      availability: { primary: false, ego: true },
    }),
    { code: "TRANSPORT_ATTEMPT_DIRECTORY_INVALID" },
  );
});
