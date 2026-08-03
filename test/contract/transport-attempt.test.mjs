import assert from "node:assert/strict";
import test from "node:test";
import {
  recordEvent,
} from "../../.agents/skills/codex-chat/scripts/lib/state.mjs";
import { runCli, tempDir } from "../helpers.mjs";

test("the installed CLI starts a route-bound transport attempt without exposing capabilities", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-cli-");
  const result = await runCli([
    "transport-attempt",
    "--action", "start",
    "--transport-state-dir", transportStateDir,
    "--workspace-id", "workspace-cli",
    "--coordinator-id", "coordinator-cli",
    "--work-unit-id", "work-unit-cli",
    "--agent-id", "agent-cli",
    "--attempt-id", "attempt-cli",
    "--primary-available", "false",
    "--ego-available", "true",
  ]);

  assert.equal(result.code, 0);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.command, "transport-attempt");
  assert.equal(result.json.data.phase, "ego_readiness_pending");
  assert.equal(result.json.data.decision, "observe_ego_initial");
  assert.equal(result.json.data.reason, "primary_unavailable");
  assert.equal(JSON.stringify(result.json).includes("leaseToken"), false);
  assert.equal(JSON.stringify(result.json).includes("claimToken"), false);
});

test("the installed CLI bounds inline transport observations before parsing", async () => {
  const transportStateDir = await tempDir("codex-chat-attempt-inline-limit-");
  const result = await runCli([
    "transport-attempt",
    "--action", "observe_primary",
    "--transport-state-dir", transportStateDir,
    "--workspace-id", "workspace-cli",
    "--coordinator-id", "coordinator-cli",
    "--work-unit-id", "work-unit-cli",
    "--agent-id", "agent-cli",
    "--attempt-id", "attempt-cli",
    "--observation-json", JSON.stringify({ value: "x".repeat(65_536) }),
  ]);

  assert.equal(result.code, 2);
  assert.equal(result.json.error.code, "JSON_INLINE_TOO_LARGE");
});

test("the installed CLI emits one canonical pre-egress collaboration report", async () => {
  const transportStateDir = await tempDir("codex-chat-outcome-cli-");
  const route = [
    "--workspace-id", "workspace-cli",
    "--coordinator-id", "coordinator-cli",
    "--work-unit-id", "work-unit-cli",
    "--agent-id", "agent-cli",
    "--attempt-id", "attempt-outcome-cli",
  ];
  const started = await runCli([
    "transport-attempt",
    "--action", "start",
    "--transport-state-dir", transportStateDir,
    ...route,
    "--primary-available", "false",
    "--ego-available", "false",
  ]);
  assert.equal(started.code, 0);

  const outcome = await runCli([
    "collaboration-outcome",
    "--transport-state-dir", transportStateDir,
    ...route,
  ]);

  assert.equal(outcome.code, 0);
  assert.equal(outcome.json.ok, true);
  assert.equal(outcome.json.command, "collaboration-outcome");
  assert.equal(
    outcome.json.data.classification,
    "transport_stopped_pre_egress",
  );
  assert.equal(outcome.json.data.authority.sourceEgress, "not_authorized");
  assert.equal(outcome.json.data.authority.externalTurn, "not_started");
  assert.match(
    outcome.json.data.statement,
    /reason=primary_and_ego_unavailable/u,
  );
});

test("the installed CLI binds a prepared run to the same coordinator route", async () => {
  const transportStateDir = await tempDir("codex-chat-outcome-run-transport-");
  const stateDir = await tempDir("codex-chat-outcome-run-state-");
  const sourceRoot = await tempDir("codex-chat-outcome-run-source-");
  const route = [
    "--workspace-id", "workspace-run",
    "--coordinator-id", "coordinator-run",
    "--work-unit-id", "work-unit-run",
    "--agent-id", "agent-run",
    "--attempt-id", "attempt-run",
  ];
  await runCli([
    "transport-attempt",
    "--action", "start",
    "--transport-state-dir", transportStateDir,
    ...route,
    "--primary-available", "false",
    "--ego-available", "true",
  ]);
  const ready = await runCli([
    "transport-attempt",
    "--action", "observe_ego",
    "--transport-state-dir", transportStateDir,
    ...route,
    "--observation-json", JSON.stringify({
      taskSpaceId: 12,
      candidateTargetId: "target-run",
      readiness: {
        providerOrigin: "https://chatgpt.com",
        providerPath: "/",
        pageReady: true,
        composerReady: true,
        composerState: "empty",
        loginControlPresent: false,
        accountUiPresent: true,
        challengePresent: false,
      },
    }),
  ]);
  assert.equal(ready.code, 0);
  assert.equal(ready.json.data.phase, "ready");
  await recordEvent({
    stateDir,
    runId: "run-outcome-cli",
    event: "prepared",
    data: {
      contextSha256: "a".repeat(64),
      sourceRoot,
      routing: {
        workspaceId: "workspace-run",
        coordinatorId: "coordinator-run",
        workUnitId: "work-unit-run",
      },
      requiredGates: ["contract"],
    },
    expectedSequence: 0,
    expectedState: null,
  });

  const outcome = await runCli([
    "collaboration-outcome",
    "--transport-state-dir", transportStateDir,
    "--state-dir", stateDir,
    "--run-id", "run-outcome-cli",
    ...route,
  ]);

  assert.equal(outcome.code, 0);
  assert.equal(outcome.json.data.classification, "capsule_prepared_not_sent");
  assert.equal(outcome.json.data.run.phase, "prepared");
  assert.equal(outcome.json.data.authority.sourceEgress, "not_reserved");
  assert.equal(outcome.json.data.authority.externalTurn, "not_started");
});
