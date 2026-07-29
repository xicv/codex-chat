import assert from "node:assert/strict";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  loadRun,
  recordEvent,
  statePaths,
} from "../../.agents/skills/codex-chat/scripts/lib/state.mjs";
import { tempDir } from "../helpers.mjs";

test("disconnect, idle observations, duplicate outputs, and changed reset times never authorize resend", async () => {
  const stateDir = await tempDir();
  const runId = "chaos-observe-only";
  let sequence = 0;
  let state = null;
  async function record(event, data = {}, idempotencyKey = null) {
    const result = await recordEvent({
      stateDir,
      runId,
      event,
      data,
      idempotencyKey,
      expectedSequence: sequence,
      expectedState: state,
      clock: () => `2026-07-29T00:00:0${sequence}.000Z`,
    });
    sequence = result.state.eventCount;
    state = result.state.phase;
    return result.state;
  }

  await record("prepared", {
    contextSha256: "a".repeat(64),
    sourceRoot: "/tmp/source",
  });
  await record("send_reserved", {
    turnId: "turn-1",
    marker: "VISIBLE_MARKER_1",
    expectedTerminalMarker: "TERMINAL_MARKER_1",
    payloadSha256: "a".repeat(64),
    conversationIdentity: "conversation-1",
  }, "reserve-1");
  await record("send_confirmed", { turnId: "turn-1" }, "send-1");
  await record("transport_disconnected", { error: "Transport closed" });
  await record("response_observed", { observation: "idle-no-output" });
  await record("resource_observation", {
    resources: {
      collaborator: {
        status: "limited",
        source: "ui",
        observedAt: "2026-07-29T00:01:00.000Z",
        expiresAt: "2026-07-30T00:00:00.000Z",
      },
    },
  });
  await record("response_observed", { observation: "long-output-part-1" });
  const final = await record("response_observed", { observation: "long-output-part-2" });

  assert.equal(final.phase, "response_pending_unknown");
  assert.equal(final.nextAction, "observe-and-reconcile-do-not-resend");
  const events = (await readFile(statePaths(stateDir, runId).events, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(events.filter(({ event }) => event === "send_reserved").length, 1);
  assert.equal(events.filter(({ event }) => event === "send_confirmed").length, 1);
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
      expectedSequence: final.eventCount,
      expectedState: final.phase,
    }),
    (error) => error.code === "INVALID_TRANSITION",
  );
});

test("both-limited suspension and local takeover are durable and monotonic", async () => {
  const stateDir = await tempDir();
  const runId = "chaos-limits";
  const events = [
    ["prepared", {
      contextSha256: "b".repeat(64),
      sourceRoot: "/tmp/source",
    }, null],
    ["send_reserved", {
      turnId: "turn-limits",
      marker: "VISIBLE_MARKER_LIMITS",
      expectedTerminalMarker: "TERMINAL_MARKER_LIMITS",
      payloadSha256: "b".repeat(64),
      conversationIdentity: "conversation-limits",
    }, "reserve-limits"],
    ["send_confirmed", { turnId: "turn-limits" }, "send-limits"],
    ["suspended_both_limited", {
      resumeAfter: "2026-07-30T01:00:00.000Z",
      reason: "Both allowances exhausted.",
    }],
    ["local_takeover", {}],
    ["resource_observation", {
      resources: {
        collaborator: {
          status: "available",
          source: "ui",
          observedAt: "2026-07-30T00:30:00.000Z",
          expiresAt: null,
        },
      },
    }],
  ];
  let phase = null;
  for (let sequence = 0; sequence < events.length; sequence += 1) {
    const [event, data, idempotencyKey = null] = events[sequence];
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

  const state = await loadRun({ stateDir, runId });
  assert.equal(state.suspended.code, "SUSPENDED_BOTH_LIMITED");
  assert.equal(state.independenceDegraded, true);
  assert.equal(state.nextAction, "wait-until-resume-after-do-not-resend");

  const terminal = await recordEvent({
    stateDir,
    runId,
    event: "response_terminal",
    data: {
      turnId: "turn-limits",
      terminalMarker: "TERMINAL_MARKER_LIMITS",
      responseSha256: "f".repeat(64),
      resultEnvelopeSha256: "e".repeat(64),
      conversationIdentity: "conversation-limits",
    },
    expectedSequence: events.length,
    expectedState: "response_pending_unknown",
  });
  assert.equal(terminal.state.suspended, null);
  assert.equal(terminal.state.nextAction, "review-response");
});

test("recovery quarantines an incomplete tail but rejects complete hash tampering", async () => {
  const stateDir = await tempDir();
  const runId = "chaos-ledger";
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
  const paths = statePaths(stateDir, runId);
  await appendFile(paths.events, '{"incomplete":');

  await assert.rejects(
    loadRun({ stateDir, runId }),
    (error) => error.code === "EVENT_LOG_PARTIAL",
  );
  const recovered = await recordEvent({
    stateDir,
    runId,
    event: "local_takeover",
    expectedSequence: 1,
    expectedState: "prepared",
  });
  assert.equal(recovered.state.phase, "prepared");
  assert.equal((await readFile(paths.events, "utf8")).endsWith("\n"), true);
  assert.equal(
    (await readdir(paths.directory)).some((name) => name.startsWith("events.partial-")),
    true,
  );

  const ledger = (await readFile(paths.events, "utf8")).trim().split("\n").map(JSON.parse);
  ledger[0].data = { contextSha256: "d".repeat(64), sourceRoot: "/tmp/source" };
  await writeFile(paths.events, `${ledger.map(JSON.stringify).join("\n")}\n`);
  await assert.rejects(
    loadRun({ stateDir, runId }),
    (error) => error.code === "EVENT_HASH_INVALID",
  );
});

test("recordEvent reclaims a durable lock left by a dead writer", async () => {
  const stateDir = await tempDir();
  const runId = "chaos-stale-lock";
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
  const paths = statePaths(stateDir, runId);
  await writeFile(paths.lock, JSON.stringify({
    pid: 99999999,
    token: "dead-writer",
    createdAt: "2026-07-29T00:00:00.000Z",
  }));

  const result = await recordEvent({
    stateDir,
    runId,
    event: "send_reserved",
    data: {
      turnId: "turn-stale-lock",
      marker: "VISIBLE_MARKER_STALE",
      expectedTerminalMarker: "TERMINAL_MARKER_STALE",
      payloadSha256: "d".repeat(64),
      conversationIdentity: "conversation-stale",
    },
    idempotencyKey: "reserve-stale",
    expectedSequence: 1,
    expectedState: "prepared",
  });
  assert.equal(result.state.phase, "send_reserved");
  assert.equal(paths.recoveryLock.endsWith(".recovery"), true);
  assert.equal(await readFile(paths.recoveryLock, "utf8").then(
    () => true,
    (error) => error.code === "ENOENT" ? false : Promise.reject(error),
  ), false);
});

test("loadRun derives from the ledger and a locked writer repairs a tampered cache", async () => {
  const stateDir = await tempDir();
  const runId = "chaos-cache";
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
  const paths = statePaths(stateDir, runId);
  const tampered = JSON.parse(await readFile(paths.state, "utf8"));
  tampered.phase = "accepted";
  tampered.nextAction = "complete";
  await writeFile(paths.state, `${JSON.stringify(tampered)}\n`);

  const readOnly = await loadRun({ stateDir, runId });
  assert.equal(readOnly.phase, "prepared");
  assert.equal(readOnly.recoveredFromEvents, true);
  assert.equal(JSON.parse(await readFile(paths.state, "utf8")).phase, "accepted");

  await recordEvent({
    stateDir,
    runId,
    event: "local_takeover",
    expectedSequence: 1,
    expectedState: "prepared",
  });
  assert.equal(JSON.parse(await readFile(paths.state, "utf8")).phase, "prepared");
});
