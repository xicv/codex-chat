import assert from "node:assert/strict";
import { chmod, readFile, stat, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { tempDir } from "../helpers.mjs";
import {
  inspectDesktopGeneration,
  transportGate,
} from "../../.agents/skills/codex-chat/scripts/lib/transport-gate.mjs";

const PROCESS_TABLE_A = `
82470 Fri Jul 31 07:43:40 2026 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
83835 Fri Jul 31 07:44:02 2026 /Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host
`;

const PROCESS_TABLE_B = `
90001 Fri Jul 31 12:00:00 2026 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
90002 Fri Jul 31 12:00:02 2026 /Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host
`;

function generationProvider(processTable) {
  return () => inspectDesktopGeneration({
    platform: "darwin",
    processTable: async () => processTable,
  });
}

function fixedClock(value) {
  return () => new Date(value);
}

test("desktop generation is stable across process ordering and changes with the host", async () => {
  const first = await inspectDesktopGeneration({
    platform: "darwin",
    processTable: async () => PROCESS_TABLE_A,
  });
  const reordered = await inspectDesktopGeneration({
    platform: "darwin",
    processTable: async () => PROCESS_TABLE_A.trim().split("\n").reverse().join("\n"),
  });
  const restarted = await inspectDesktopGeneration({
    platform: "darwin",
    processTable: async () => PROCESS_TABLE_B,
  });

  assert.equal(first.ready, true);
  assert.equal(first.app.pid, 82470);
  assert.equal(first.host.pid, 83835);
  assert.equal(first.generationId, reordered.generationId);
  assert.notEqual(first.generationId, restarted.generationId);
  assert.notEqual(first.hostGenerationId, restarted.hostGenerationId);
});

test("desktop generation fails closed on unsupported platforms", async () => {
  const transportStateDir = await tempDir("codex-chat-transport-unsupported-");
  const generation = await inspectDesktopGeneration({ platform: "win32" });
  const result = await transportGate({
    action: "claim",
    transportStateDir,
    generationProvider: async () => generation,
    clock: fixedClock("2026-07-31T02:30:00.000Z"),
    createToken: () => "unused",
  });

  assert.equal(result.probeAllowed, false);
  assert.equal(result.reason, "desktop_generation_unsupported");
  await assert.rejects(
    readFile(path.join(transportStateDir, "gate.json"), "utf8"),
    { code: "ENOENT" },
  );
});

test("a failed generation stays open until the browser host actually changes", async () => {
  const transportStateDir = await tempDir("codex-chat-transport-gate-");
  const firstClaim = await transportGate({
    action: "claim",
    transportStateDir,
    generationProvider: generationProvider(PROCESS_TABLE_A),
    clock: fixedClock("2026-07-31T02:30:00.000Z"),
    createToken: () => "claim-a",
  });
  assert.equal(firstClaim.probeAllowed, true);
  assert.equal(firstClaim.claimToken, "claim-a");

  const concurrent = await transportGate({
    action: "claim",
    transportStateDir,
    generationProvider: generationProvider(PROCESS_TABLE_A),
    clock: fixedClock("2026-07-31T02:30:10.000Z"),
    createToken: () => "unused",
  });
  assert.equal(concurrent.probeAllowed, false);
  assert.equal(concurrent.reason, "probe_in_progress");

  await transportGate({
    action: "failure",
    claimToken: "claim-a",
    transportStateDir,
    generationProvider: generationProvider(PROCESS_TABLE_A),
    clock: fixedClock("2026-07-31T02:30:20.000Z"),
  });

  const unchanged = await transportGate({
    action: "claim",
    transportStateDir,
    generationProvider: generationProvider(PROCESS_TABLE_A),
    clock: fixedClock("2026-07-31T02:31:00.000Z"),
    createToken: () => "unused",
  });
  assert.equal(unchanged.probeAllowed, false);
  assert.equal(unchanged.reason, "same_host_generation_failed");
  assert.equal(unchanged.restartVerified, false);

  const restarted = await transportGate({
    action: "claim",
    transportStateDir,
    generationProvider: generationProvider(PROCESS_TABLE_B),
    clock: fixedClock("2026-07-31T02:32:00.000Z"),
    createToken: () => "claim-b",
  });
  assert.equal(restarted.probeAllowed, true);
  assert.equal(restarted.reason, "host_generation_changed");
  assert.equal(restarted.restartVerified, true);
  assert.equal(restarted.claimToken, "claim-b");
});

test("a successful probe closes the breaker and permits a later serialized probe", async () => {
  const transportStateDir = await tempDir("codex-chat-transport-success-");
  const common = {
    transportStateDir,
    generationProvider: generationProvider(PROCESS_TABLE_A),
  };
  const claimed = await transportGate({
    action: "claim",
    ...common,
    clock: fixedClock("2026-07-31T02:30:00.000Z"),
    createToken: () => "claim-success",
  });
  assert.equal(claimed.probeAllowed, true);

  const success = await transportGate({
    action: "success",
    claimToken: "claim-success",
    ...common,
    clock: fixedClock("2026-07-31T02:30:01.000Z"),
  });
  assert.equal(success.gateState, "closed");

  const next = await transportGate({
    action: "claim",
    ...common,
    clock: fixedClock("2026-07-31T02:30:02.000Z"),
    createToken: () => "claim-next",
  });
  assert.equal(next.probeAllowed, true);
  assert.equal(next.reason, "probe_claimed");
});

test("a neutral release frees a claimed probe without recording transport health", async () => {
  const transportStateDir = await tempDir("codex-chat-transport-release-");
  const common = {
    transportStateDir,
    generationProvider: generationProvider(PROCESS_TABLE_A),
  };
  await transportGate({
    action: "claim",
    ...common,
    clock: fixedClock("2026-07-31T02:30:00.000Z"),
    createToken: () => "claim-release",
  });

  const released = await transportGate({
    action: "release",
    claimToken: "claim-release",
    ...common,
    clock: fixedClock("2026-07-31T02:30:01.000Z"),
  });
  assert.equal(released.gateState, "idle");
  assert.equal(released.probeAllowed, false);
  assert.equal(released.reason, "probe_released");
  assert.equal(released.previousFailure, null);

  const record = JSON.parse(
    await readFile(path.join(transportStateDir, "gate.json"), "utf8"),
  );
  assert.equal(record.status, "idle");
  assert.equal(record.claimToken, null);
  assert.equal(record.lastFailure, null);
  assert.equal(record.lastSuccessAt, null);

  const next = await transportGate({
    action: "claim",
    ...common,
    clock: fixedClock("2026-07-31T02:30:02.000Z"),
    createToken: () => "claim-after-release",
  });
  assert.equal(next.probeAllowed, true);
  assert.equal(next.reason, "probe_claimed");
});

test("a neutral release does not depend on another desktop generation probe", async () => {
  const transportStateDir = await tempDir("codex-chat-transport-release-host-");
  await transportGate({
    action: "claim",
    transportStateDir,
    generationProvider: generationProvider(PROCESS_TABLE_A),
    clock: fixedClock("2026-07-31T02:30:00.000Z"),
    createToken: () => "claim-release-host",
  });

  const released = await transportGate({
    action: "release",
    claimToken: "claim-release-host",
    transportStateDir,
    generationProvider: async () => {
      throw new Error("desktop generation unavailable");
    },
    clock: fixedClock("2026-07-31T02:30:01.000Z"),
  });
  assert.equal(released.gateState, "idle");
  assert.equal(released.reason, "probe_released");
  assert.equal(released.generation.ready, null);
  assert.equal(released.generation.reason, "claimed_generation_not_reprobed");
});

test("stale claim tokens cannot close or trip another coordinator's gate", async () => {
  const transportStateDir = await tempDir("codex-chat-transport-stale-");
  const common = {
    transportStateDir,
    generationProvider: generationProvider(PROCESS_TABLE_A),
  };
  await transportGate({
    action: "claim",
    ...common,
    clock: fixedClock("2026-07-31T02:30:00.000Z"),
    createToken: () => "owner-token",
  });

  await assert.rejects(
    transportGate({
      action: "failure",
      claimToken: "stale-token",
      ...common,
      clock: fixedClock("2026-07-31T02:30:01.000Z"),
    }),
    { code: "TRANSPORT_GATE_CLAIM_MISMATCH" },
  );
  await assert.rejects(
    transportGate({
      action: "release",
      claimToken: "stale-token",
      ...common,
      clock: fixedClock("2026-07-31T02:30:01.000Z"),
    }),
    { code: "TRANSPORT_GATE_CLAIM_MISMATCH" },
  );
});

test("transport state refuses a symlinked gate record", async () => {
  const transportStateDir = await tempDir("codex-chat-transport-symlink-");
  const outside = path.join(await tempDir("codex-chat-transport-outside-"), "gate.json");
  await symlink(outside, path.join(transportStateDir, "gate.json"));

  await assert.rejects(
    transportGate({
      action: "claim",
      transportStateDir,
      generationProvider: generationProvider(PROCESS_TABLE_A),
      clock: fixedClock("2026-07-31T02:30:00.000Z"),
      createToken: () => "claim",
    }),
    { code: "TRANSPORT_GATE_STATE_INVALID" },
  );

  await assert.rejects(readFile(outside, "utf8"), { code: "ENOENT" });
});

test("transport state refuses a shared directory without changing its mode", async () => {
  const transportStateDir = await tempDir("codex-chat-transport-shared-");
  await chmod(transportStateDir, 0o755);

  await assert.rejects(
    transportGate({
      action: "claim",
      transportStateDir,
      generationProvider: generationProvider(PROCESS_TABLE_A),
      clock: fixedClock("2026-07-31T02:30:00.000Z"),
      createToken: () => "claim",
    }),
    { code: "TRANSPORT_GATE_DIRECTORY_INVALID" },
  );

  assert.equal((await stat(transportStateDir)).mode & 0o777, 0o755);
});
