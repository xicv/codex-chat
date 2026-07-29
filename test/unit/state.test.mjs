import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  loadRun,
  recordEvent,
  statePaths,
} from "../../.agents/skills/codex-chat/scripts/lib/state.mjs";
import { LIMITS_V1 } from "../../.agents/skills/codex-chat/scripts/lib/limits.mjs";
import { tempDir } from "../helpers.mjs";

test("recordEvent enforces transitions and maintains a verified event hash chain", async () => {
  const stateDir = await tempDir();
  const runId = "run-1";
  const clock = () => "2026-07-29T00:00:00.000Z";

  await recordEvent({
    stateDir,
    runId,
    event: "prepared",
    data: {
      contextSha256: "a".repeat(64),
      sourceRoot: "/tmp/source",
      parent: null,
    },
    expectedSequence: 0,
    expectedState: null,
    clock,
  });
  await recordEvent({
    stateDir,
    runId,
    event: "send_reserved",
    data: {
      turnId: "turn-1",
      marker: "VISIBLE_MARKER_1",
      expectedTerminalMarker: "TERMINAL_MARKER_1",
      payloadSha256: "a".repeat(64),
      conversationIdentity: "conversation-1",
    },
    expectedSequence: 1,
    expectedState: "prepared",
    idempotencyKey: "reserve-1",
    clock,
  });
  const confirmed = await recordEvent({
    stateDir,
    runId,
    event: "send_confirmed",
    expectedSequence: 2,
    expectedState: "send_reserved",
    idempotencyKey: "send-1",
    data: {
      turnId: "turn-1",
      conversationUrl: "https://chatgpt.com/c/example",
    },
    clock,
  });

  assert.equal(confirmed.state.phase, "send_confirmed");
  assert.equal(confirmed.state.nextAction, "observe-only-do-not-resend");
  assert.deepEqual(confirmed.state.collaboration, {
    conversationUrl: "https://chatgpt.com/c/example",
    outboundTurnId: "turn-1",
    terminalMarker: null,
    responseBinding: null,
  });
  const loaded = await loadRun({ stateDir, runId });
  assert.equal(loaded.eventCount, 3);
  assert.equal(loaded.parent, null);
  assert.equal(loaded.lastEventHash, confirmed.state.lastEventHash);

  const lines = (await readFile(statePaths(stateDir, runId).events, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(lines[0].previousHash, null);
  assert.equal(lines[1].previousHash, lines[0].hash);
  assert.equal(lines[2].previousHash, lines[1].hash);

  await assert.rejects(
    recordEvent({
      stateDir,
      runId,
      event: "send_reserved",
      data: {
        turnId: "turn-unsafe",
        marker: "VISIBLE_MARKER_UNSAFE",
        expectedTerminalMarker: "TERMINAL_MARKER_UNSAFE",
        payloadSha256: "a".repeat(64),
        conversationIdentity: "conversation-unsafe",
      },
      idempotencyKey: "unsafe-reserve",
      expectedSequence: 3,
      expectedState: "send_confirmed",
      clock,
    }),
    (error) => error.code === "INVALID_TRANSITION",
  );
});

test("idempotency and event-first crash recovery prevent duplicate sends", async () => {
  const stateDir = await tempDir();
  const runId = "run-crash";
  const clock = () => "2026-07-29T00:00:00.000Z";
  await recordEvent({
    stateDir,
    runId,
    event: "prepared",
    data: {
      contextSha256: "b".repeat(64),
      sourceRoot: "/tmp/source",
    },
    expectedSequence: 0,
    expectedState: null,
    clock,
  });

  await assert.rejects(
    recordEvent({
      stateDir,
      runId,
      event: "send_reserved",
      data: {
        turnId: "turn-crash",
        marker: "VISIBLE_MARKER_CRASH",
        expectedTerminalMarker: "TERMINAL_MARKER_CRASH",
        payloadSha256: "b".repeat(64),
        conversationIdentity: "conversation-crash",
      },
      expectedSequence: 1,
      expectedState: "prepared",
      idempotencyKey: "reserve-1",
      clock,
      crashAfterEvent: true,
    }),
    (error) => error.code === "SIMULATED_CRASH",
  );

  const recovered = await loadRun({ stateDir, runId });
  assert.equal(recovered.phase, "send_reserved");
  assert.equal(recovered.recoveredFromEvents, true);
  assert.equal(recovered.nextAction, "reconcile-marker-before-send");
  assert.equal(recovered.outbound.marker, "VISIBLE_MARKER_CRASH");
  assert.deepEqual(recovered.outboundIdempotencyKeys, ["reserve-1"]);

  const duplicate = await recordEvent({
    stateDir,
    runId,
    event: "send_reserved",
    data: {
      turnId: "turn-crash",
      marker: "VISIBLE_MARKER_CRASH",
      expectedTerminalMarker: "TERMINAL_MARKER_CRASH",
      payloadSha256: "b".repeat(64),
      conversationIdentity: "conversation-crash",
    },
    expectedSequence: 1,
    expectedState: "prepared",
    idempotencyKey: "reserve-1",
    clock,
  });
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.state.eventCount, 2);
});

test("outbound reservations require durable metadata and permanent idempotency", async () => {
  const stateDir = await tempDir();
  const runId = "run-outbound-contract";
  await recordEvent({
    stateDir,
    runId,
    event: "prepared",
    data: {
      contextSha256: "c".repeat(64),
      sourceRoot: "/tmp/source",
    },
    expectedSequence: 0,
    expectedState: null,
  });
  await assert.rejects(
    recordEvent({
      stateDir,
      runId,
      event: "send_reserved",
      data: {
        turnId: "turn-1",
        marker: "VISIBLE_MARKER",
        expectedTerminalMarker: "TERMINAL_MARKER",
        payloadSha256: "c".repeat(64),
        conversationIdentity: "conversation-1",
      },
      expectedSequence: 1,
      expectedState: "prepared",
    }),
    (error) => error.code === "OUTBOUND_IDEMPOTENCY_REQUIRED",
  );
});

test("coordinated runs reject crossed agent and coordinator confirmations", async () => {
  const stateDir = await tempDir();
  const runId = "run-routing-isolation";
  const routing = {
    workspaceId: "workspace-1",
    coordinatorId: "coordinator-1",
    workUnitId: "work-unit-1",
  };
  const outboundRouting = { ...routing, agentId: "agent-1" };
  await recordEvent({
    stateDir,
    runId,
    event: "prepared",
    data: {
      contextSha256: "c".repeat(64),
      sourceRoot: "/tmp/source",
      routing,
      requiredGates: ["unit"],
    },
    expectedSequence: 0,
    expectedState: null,
  });
  await recordEvent({
    stateDir,
    runId,
    event: "send_reserved",
    data: {
      turnId: "turn-1",
      marker: "VISIBLE_ROUTED_MARKER",
      expectedTerminalMarker: "TERMINAL_ROUTED_MARKER",
      payloadSha256: "c".repeat(64),
      conversationIdentity: "conversation-routed",
      routing: outboundRouting,
    },
    expectedSequence: 1,
    expectedState: "prepared",
    idempotencyKey: "routed-reservation",
  });

  const confirmation = {
    turnId: "turn-1",
    marker: "VISIBLE_ROUTED_MARKER",
    conversationIdentity: "conversation-routed",
    conversationUrl: "https://chatgpt.com/c/routed",
    routing: outboundRouting,
    transportKind: "native-bridge",
    observedAt: "2026-07-29T00:00:00.000Z",
    confirmationEvidenceClass: "thread-id-observation",
    providerMessageFingerprint: null,
    locator: { type: "thread-id", value: "conversation-routed" },
  };
  await assert.rejects(
    recordEvent({
      stateDir,
      runId,
      event: "send_confirmed",
      data: {
        ...confirmation,
        routing: { ...outboundRouting, coordinatorId: "coordinator-2" },
      },
      expectedSequence: 2,
      expectedState: "send_reserved",
      idempotencyKey: "wrong-coordinator",
    }),
    (error) => error.code === "SEND_CONFIRMATION_EVIDENCE_INVALID",
  );
  const confirmed = await recordEvent({
    stateDir,
    runId,
    event: "send_confirmed",
    data: confirmation,
    expectedSequence: 2,
    expectedState: "send_reserved",
    idempotencyKey: "routed-confirmation",
  });
  assert.deepEqual(confirmed.state.outbound.routing, outboundRouting);
  assert.equal(
    confirmed.state.outbound.confirmationEvidence.locator.value,
    "conversation-routed",
  );
});

test("idempotency keys bind event type and canonical data while markers remain unique", async () => {
  const stateDir = await tempDir();
  const runId = "run-idempotency-binding";
  await recordEvent({
    stateDir,
    runId,
    event: "prepared",
    data: {
      contextSha256: "d".repeat(64),
      sourceRoot: "/tmp/source",
    },
    expectedSequence: 0,
    expectedState: null,
  });
  const reservation = {
    turnId: "turn-1",
    marker: "VISIBLE_MARKER_BOUND",
    expectedTerminalMarker: "TERMINAL_MARKER_BOUND",
    payloadSha256: "d".repeat(64),
    conversationIdentity: "conversation-bound",
  };
  await recordEvent({
    stateDir,
    runId,
    event: "send_reserved",
    data: reservation,
    expectedSequence: 1,
    expectedState: "prepared",
    idempotencyKey: "bound-key",
  });

  await assert.rejects(
    recordEvent({
      stateDir,
      runId,
      event: "send_reserved",
      data: { ...reservation, marker: "DIFFERENT_MARKER" },
      expectedSequence: 1,
      expectedState: "prepared",
      idempotencyKey: "bound-key",
    }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    recordEvent({
      stateDir,
      runId,
      event: "send_confirmed",
      data: { turnId: "turn-1" },
      expectedSequence: 2,
      expectedState: "send_reserved",
      idempotencyKey: "bound-key",
    }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("terminal responses are bound to the active outbound turn and expected marker", async () => {
  const stateDir = await tempDir();
  const runId = "run-terminal-binding";
  await recordEvent({
    stateDir,
    runId,
    event: "prepared",
    data: {
      contextSha256: "e".repeat(64),
      sourceRoot: "/tmp/source",
    },
    expectedSequence: 0,
    expectedState: null,
  });
  await recordEvent({
    stateDir,
    runId,
    event: "send_reserved",
    data: {
      turnId: "turn-terminal",
      marker: "VISIBLE_MARKER_TERMINAL",
      expectedTerminalMarker: "EXPECTED_TERMINAL",
      payloadSha256: "e".repeat(64),
      conversationIdentity: "conversation-terminal",
    },
    expectedSequence: 1,
    expectedState: "prepared",
    idempotencyKey: "terminal-reserved",
  });
  await recordEvent({
    stateDir,
    runId,
    event: "send_confirmed",
    data: { turnId: "turn-terminal" },
    expectedSequence: 2,
    expectedState: "send_reserved",
    idempotencyKey: "terminal-confirmed",
  });

  await assert.rejects(
    recordEvent({
      stateDir,
      runId,
      event: "response_terminal",
      data: {
        turnId: "different-turn",
        terminalMarker: "EXPECTED_TERMINAL",
        responseSha256: "f".repeat(64),
        conversationIdentity: "conversation-terminal",
      },
      expectedSequence: 3,
      expectedState: "send_confirmed",
    }),
    (error) => error.code === "TERMINAL_RESPONSE_INVALID",
  );

  const terminal = await recordEvent({
    stateDir,
    runId,
    event: "response_terminal",
    data: {
      turnId: "turn-terminal",
      terminalMarker: "EXPECTED_TERMINAL",
      responseSha256: "f".repeat(64),
      resultEnvelopeSha256: "a".repeat(64),
      conversationIdentity: "conversation-terminal",
    },
    expectedSequence: 3,
    expectedState: "send_confirmed",
  });
  assert.deepEqual(terminal.state.collaboration.responseBinding, {
    turnId: "turn-terminal",
    terminalMarker: "EXPECTED_TERMINAL",
    responseSha256: "f".repeat(64),
    resultEnvelopeSha256: "a".repeat(64),
    conversationIdentity: "conversation-terminal",
  });
  await recordEvent({
    stateDir,
    runId,
    event: "review_started",
    expectedSequence: 4,
    expectedState: "response_terminal",
  });
  await recordEvent({
    stateDir,
    runId,
    event: "needs_revision",
    expectedSequence: 5,
    expectedState: "reviewing",
  });
  await assert.rejects(
    recordEvent({
      stateDir,
      runId,
      event: "send_reserved",
      data: {
        turnId: "turn-revision",
        marker: "VISIBLE_MARKER_TERMINAL",
        expectedTerminalMarker: "EXPECTED_REVISION_TERMINAL",
        payloadSha256: "a".repeat(64),
        conversationIdentity: "conversation-terminal",
      },
      expectedSequence: 6,
      expectedState: "needs_revision",
      idempotencyKey: "revision-reused-marker",
    }),
    (error) => error.code === "OUTBOUND_MARKER_REUSED",
  );
  const revision = await recordEvent({
    stateDir,
    runId,
    event: "send_reserved",
    data: {
      turnId: "turn-revision",
      marker: "VISIBLE_MARKER_REVISION",
      expectedTerminalMarker: "EXPECTED_REVISION_TERMINAL",
      payloadSha256: "a".repeat(64),
      conversationIdentity: "conversation-terminal",
    },
    expectedSequence: 6,
    expectedState: "needs_revision",
    idempotencyKey: "revision-unique-marker",
  });
  assert.equal(revision.state.collaboration.terminalMarker, null);
  assert.equal(revision.state.collaboration.responseBinding, null);
});

test("legacy acceptance remains valid JSON without coordinated gate metadata", async () => {
  const stateDir = await tempDir();
  const runId = "legacy-acceptance";
  const events = [
    ["prepared", {
      contextSha256: "a".repeat(64),
      sourceRoot: "/tmp/source",
    }, null],
    ["send_reserved", {
      turnId: "turn-legacy",
      marker: "VISIBLE_LEGACY",
      expectedTerminalMarker: "TERMINAL_LEGACY",
      payloadSha256: "a".repeat(64),
      conversationIdentity: "conversation-legacy",
    }, "legacy-reserved"],
    ["send_confirmed", {
      turnId: "turn-legacy",
    }, "legacy-confirmed"],
    ["response_terminal", {
      turnId: "turn-legacy",
      terminalMarker: "TERMINAL_LEGACY",
      responseSha256: "b".repeat(64),
      resultEnvelopeSha256: "c".repeat(64),
      conversationIdentity: "conversation-legacy",
    }, null],
    ["review_started", {}, null],
    ["validation_started", {}, null],
    ["accepted", {}, null],
  ];
  let phase = null;
  for (const [sequence, [event, data, idempotencyKey]] of events.entries()) {
    const result = await recordEvent({
      stateDir,
      runId,
      event,
      data,
      idempotencyKey,
      expectedSequence: sequence,
      expectedState: phase,
    });
    phase = result.state.phase;
  }

  const persisted = JSON.parse(
    await readFile(statePaths(stateDir, runId).state, "utf8"),
  );
  assert.equal(persisted.phase, "accepted");
  assert.equal(persisted.verificationSetSha256, null);
  assert.equal((await loadRun({ stateDir, runId })).phase, "accepted");
});

test("hardened outbound reservations bind context and exact task-envelope digests", async () => {
  const stateDir = await tempDir();
  const runId = "run-hardened-binding";
  const routing = {
    workspaceId: "workspace-hardened",
    coordinatorId: "coordinator-hardened",
    workUnitId: "work-unit-hardened",
  };
  const contextSha256 = "1".repeat(64);
  const taskEnvelopeSha256 = "2".repeat(64);
  await recordEvent({
    stateDir,
    runId,
    event: "prepared",
    data: {
      contextSha256,
      taskEnvelopeSha256,
      outboundBindingVersion: 2,
      sourceRoot: "/tmp/source",
      routing,
      requiredGates: ["unit"],
    },
    expectedSequence: 0,
    expectedState: null,
  });

  const reservation = {
    turnId: "turn-hardened",
    marker: "VISIBLE_HARDENED",
    expectedTerminalMarker: "TERMINAL_HARDENED",
    payloadSha256: contextSha256,
    contextSha256,
    taskEnvelopeSha256,
    outboundBindingVersion: 2,
    providerNamespace: "chatgpt",
    conversationIdentity: "conversation-hardened",
    routing: { ...routing, agentId: "agent-hardened" },
  };
  await assert.rejects(
    recordEvent({
      stateDir,
      runId,
      event: "send_reserved",
      data: { ...reservation, taskEnvelopeSha256: "3".repeat(64) },
      expectedSequence: 1,
      expectedState: "prepared",
      idempotencyKey: "hardened-mismatch",
    }),
    (error) => error.code === "SEND_TASK_ENVELOPE_MISMATCH",
  );

  const result = await recordEvent({
    stateDir,
    runId,
    event: "send_reserved",
    data: reservation,
    expectedSequence: 1,
    expectedState: "prepared",
    idempotencyKey: "hardened-reservation",
  });
  assert.equal(result.state.outbound.contextSha256, contextSha256);
  assert.equal(result.state.outbound.taskEnvelopeSha256, taskEnvelopeSha256);
  assert.equal(result.state.outbound.payloadSha256, contextSha256);
  assert.equal(result.state.outbound.outboundBindingVersion, 2);
});

test("conversation leases isolate coordinators by identity and confirmed locator", async () => {
  const stateDir = await tempDir();
  const contextSha256 = "4".repeat(64);
  const taskEnvelopeSha256 = "5".repeat(64);

  async function prepareAndReserve({
    runId,
    coordinatorId,
    conversationIdentity,
    idempotencyKey,
  }) {
    const routing = {
      workspaceId: "workspace-shared",
      coordinatorId,
      workUnitId: `work-${runId}`,
    };
    await recordEvent({
      stateDir,
      runId,
      event: "prepared",
      data: {
        contextSha256,
        taskEnvelopeSha256,
        outboundBindingVersion: 2,
        sourceRoot: "/tmp/source",
        routing,
        requiredGates: ["unit"],
      },
      expectedSequence: 0,
      expectedState: null,
    });
    const outboundRouting = { ...routing, agentId: `agent-${runId}` };
    const state = await recordEvent({
      stateDir,
      runId,
      event: "send_reserved",
      data: {
        turnId: `turn-${runId}`,
        marker: `VISIBLE_${runId}`,
        expectedTerminalMarker: `TERMINAL_${runId}`,
        payloadSha256: contextSha256,
        contextSha256,
        taskEnvelopeSha256,
        outboundBindingVersion: 2,
        providerNamespace: "chatgpt",
        conversationIdentity,
        routing: outboundRouting,
      },
      expectedSequence: 1,
      expectedState: "prepared",
      idempotencyKey,
    });
    return { state: state.state, outboundRouting };
  }

  const first = await prepareAndReserve({
    runId: "lease-one",
    coordinatorId: "coordinator-one",
    conversationIdentity: "shared-logical-conversation",
    idempotencyKey: "lease-one-reserve",
  });
  await assert.rejects(
    prepareAndReserve({
      runId: "lease-two",
      coordinatorId: "coordinator-two",
      conversationIdentity: "shared-logical-conversation",
      idempotencyKey: "lease-two-reserve",
    }),
    (error) => error.code === "CONVERSATION_LEASE_CONFLICT",
  );

  await recordEvent({
    stateDir,
    runId: "lease-one",
    event: "send_confirmed",
    data: {
      turnId: "turn-lease-one",
      marker: "VISIBLE_lease-one",
      conversationIdentity: "shared-logical-conversation",
      routing: first.outboundRouting,
      providerNamespace: "chatgpt",
      transportKind: "native-chat",
      observedAt: "2026-07-29T00:00:00.000Z",
      confirmationEvidenceClass: "thread-id-observation",
      providerMessageFingerprint: null,
      locator: { type: "thread-id", value: "provider-thread-shared" },
    },
    expectedSequence: 2,
    expectedState: "send_reserved",
    idempotencyKey: "lease-one-confirm",
  });

  const third = await prepareAndReserve({
    runId: "lease-three",
    coordinatorId: "coordinator-three",
    conversationIdentity: "different-logical-conversation",
    idempotencyKey: "lease-three-reserve",
  });
  await assert.rejects(
    recordEvent({
      stateDir,
      runId: "lease-three",
      event: "send_confirmed",
      data: {
        turnId: "turn-lease-three",
        marker: "VISIBLE_lease-three",
        conversationIdentity: "different-logical-conversation",
        routing: third.outboundRouting,
        providerNamespace: "chatgpt",
        transportKind: "native-chat",
        observedAt: "2026-07-29T00:00:00.000Z",
        confirmationEvidenceClass: "thread-id-observation",
        providerMessageFingerprint: null,
        locator: { type: "thread-id", value: "provider-thread-shared" },
      },
      expectedSequence: 2,
      expectedState: "send_reserved",
      idempotencyKey: "lease-three-confirm",
    }),
    (error) => error.code === "CONVERSATION_LEASE_CONFLICT",
  );

  await recordEvent({
    stateDir,
    runId: "lease-one",
    event: "blocked",
    data: { reason: "test complete" },
    expectedSequence: 3,
    expectedState: "send_confirmed",
  });
  const replacement = await prepareAndReserve({
    runId: "lease-four",
    coordinatorId: "coordinator-four",
    conversationIdentity: "shared-logical-conversation",
    idempotencyKey: "lease-four-reserve",
  });
  assert.equal(replacement.state.phase, "send_reserved");
  const replacementConfirmed = await recordEvent({
    stateDir,
    runId: "lease-four",
    event: "send_confirmed",
    data: {
      turnId: "turn-lease-four",
      marker: "VISIBLE_lease-four",
      conversationIdentity: "shared-logical-conversation",
      routing: replacement.outboundRouting,
      providerNamespace: "chatgpt",
      transportKind: "native-chat",
      observedAt: "2026-07-29T00:00:01.000Z",
      confirmationEvidenceClass: "thread-id-observation",
      providerMessageFingerprint: null,
      locator: { type: "thread-id", value: "provider-thread-shared" },
    },
    expectedSequence: 2,
    expectedState: "send_reserved",
    idempotencyKey: "lease-four-confirm",
  });
  assert.equal(replacementConfirmed.state.phase, "send_confirmed");
});

test("general idempotency records are bounded while outbound records are permanent", async () => {
  const stateDir = await tempDir();
  const runId = "run-bounded-idempotency";
  await recordEvent({
    stateDir,
    runId,
    event: "prepared",
    data: {
      contextSha256: "6".repeat(64),
      sourceRoot: "/tmp/source",
    },
    expectedSequence: 0,
    expectedState: null,
    idempotencyKey: "prepared-key",
  });
  await recordEvent({
    stateDir,
    runId,
    event: "send_reserved",
    data: {
      turnId: "turn-bounded",
      marker: "VISIBLE_BOUNDED",
      expectedTerminalMarker: "TERMINAL_BOUNDED",
      payloadSha256: "6".repeat(64),
      conversationIdentity: "conversation-bounded",
    },
    expectedSequence: 1,
    expectedState: "prepared",
    idempotencyKey: "permanent-outbound",
  });

  let sequence = 2;
  for (let index = 0; index < LIMITS_V1.ledger.retainedIdempotencyKeys + 8; index += 1) {
    const result = await recordEvent({
      stateDir,
      runId,
      event: "local_takeover",
      data: { index },
      expectedSequence: sequence,
      expectedState: "send_reserved",
      idempotencyKey: `general-${index}`,
    });
    sequence = result.state.eventCount;
  }
  const state = await loadRun({ stateDir, runId });
  assert.equal(state.idempotencyKeys.length, LIMITS_V1.ledger.retainedIdempotencyKeys);
  assert.equal(
    Object.keys(state.idempotencyRecords).length,
    LIMITS_V1.ledger.retainedIdempotencyKeys + 1,
  );
  assert.equal(state.idempotencyRecords["permanent-outbound"].event, "send_reserved");
  assert.equal(state.idempotencyRecords["prepared-key"], undefined);
});

test("resource observation coalescing suppresses equivalent short-lived noise", async () => {
  const stateDir = await tempDir();
  const runId = "run-observation-coalescing";
  await recordEvent({
    stateDir,
    runId,
    event: "prepared",
    data: {
      contextSha256: "7".repeat(64),
      sourceRoot: "/tmp/source",
    },
    expectedSequence: 0,
    expectedState: null,
    clock: () => "2026-07-29T00:00:00.000Z",
  });
  const first = await recordEvent({
    stateDir,
    runId,
    event: "resource_observation",
    data: {
      coalesce: true,
      resources: {
        transport: {
          status: "available",
          source: "adapter",
          observedAt: "2026-07-29T00:00:01.000Z",
          expiresAt: null,
          lastError: null,
        },
      },
    },
    expectedSequence: 1,
    expectedState: "prepared",
  });
  const repeated = await recordEvent({
    stateDir,
    runId,
    event: "resource_observation",
    data: {
      coalesce: true,
      resources: {
        transport: {
          status: "available",
          source: "adapter",
          observedAt: "2026-07-29T00:00:02.000Z",
          expiresAt: null,
          lastError: null,
        },
      },
    },
    expectedSequence: 2,
    expectedState: "prepared",
  });
  assert.equal(repeated.coalesced, true);
  assert.equal(repeated.state.eventCount, first.state.eventCount);

  const later = await recordEvent({
    stateDir,
    runId,
    event: "resource_observation",
    data: {
      coalesce: true,
      resources: {
        transport: {
          status: "available",
          source: "adapter",
          observedAt: "2026-07-29T00:00:20.000Z",
          expiresAt: null,
          lastError: null,
        },
      },
    },
    expectedSequence: 2,
    expectedState: "prepared",
  });
  assert.equal(later.coalesced, false);
  assert.equal(later.state.eventCount, 3);
});

test("run event limits fail closed and require a digest-bound continuation run", async () => {
  const stateDir = await tempDir();
  const first = await recordEvent({
    stateDir,
    runId: "run-segment-one",
    event: "prepared",
    data: {
      contextSha256: "8".repeat(64),
      sourceRoot: "/tmp/source",
    },
    expectedSequence: 0,
    expectedState: null,
    maxEventsPerRun: 34,
  });
  const second = await recordEvent({
    stateDir,
    runId: "run-segment-one",
    event: "local_takeover",
    expectedSequence: 1,
    expectedState: "prepared",
    maxEventsPerRun: 34,
  });
  await assert.rejects(
    recordEvent({
      stateDir,
      runId: "run-segment-one",
      event: "resource_observation",
      data: {
        resources: {
          transport: {
            status: "available",
            source: "adapter",
          },
        },
      },
      expectedSequence: 2,
      expectedState: "prepared",
      maxEventsPerRun: 34,
    }),
    (error) => error.code === "RUN_EVENT_LIMIT",
  );

  await assert.rejects(
    recordEvent({
      stateDir,
      runId: "run-segment-two",
      event: "prepared",
      data: {
        contextSha256: "8".repeat(64),
        sourceRoot: "/tmp/source",
        parent: {
          runId: first.state.runId,
          eventSequence: second.state.eventCount,
          eventHash: "9".repeat(64),
        },
      },
      expectedSequence: 0,
      expectedState: null,
    }),
    (error) => error.code === "PARENT_RUN_MISMATCH",
  );

  const continuation = await recordEvent({
    stateDir,
    runId: "run-segment-two",
    event: "prepared",
    data: {
      contextSha256: "8".repeat(64),
      sourceRoot: "/tmp/source",
      parent: {
        runId: first.state.runId,
        eventSequence: second.state.eventCount,
        eventHash: second.state.lastEventHash,
      },
    },
    expectedSequence: 0,
    expectedState: null,
  });
  assert.deepEqual(continuation.state.parent, {
    runId: "run-segment-one",
    eventSequence: 2,
    eventHash: second.state.lastEventHash,
  });
});
