import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  loadRun,
  recordEvent,
  statePaths,
} from "../../.agents/skills/codex-chat/scripts/lib/state.mjs";
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
