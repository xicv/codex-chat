import assert from "node:assert/strict";
import test from "node:test";
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
