import assert from "node:assert/strict";
import { chmod, readFile, stat, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runCli, tempDir } from "../helpers.mjs";
import {
  egoBootstrapLease,
  egoBootstrapLeasePaths,
} from "../../.agents/skills/codex-chat/scripts/lib/ego-bootstrap-lease.mjs";

const OWNER_A = Object.freeze({
  workspaceId: "workspace-a",
  coordinatorId: "coordinator-a",
  workUnitId: "work-unit-a",
  agentId: "agent-a",
  attemptId: "attempt-a",
});

const OWNER_B = Object.freeze({
  workspaceId: "workspace-a",
  coordinatorId: "coordinator-b",
  workUnitId: "work-unit-b",
  agentId: "agent-b",
  attemptId: "attempt-b",
});

function fixedClock(value) {
  return () => new Date(value);
}

test("one Ego bootstrap owner excludes concurrent coordinators without persisting its token", async () => {
  const transportStateDir = await tempDir("codex-chat-ego-bootstrap-");
  const [left, right] = await Promise.all([
    egoBootstrapLease({
      action: "acquire",
      transportStateDir,
      owner: OWNER_A,
      clock: fixedClock("2026-08-01T01:00:00.000Z"),
      createToken: () => "lease-token-a-0123456789",
      createLeaseId: () => "lease-a",
    }),
    egoBootstrapLease({
      action: "acquire",
      transportStateDir,
      owner: OWNER_B,
      clock: fixedClock("2026-08-01T01:00:00.000Z"),
      createToken: () => "lease-token-b-0123456789",
      createLeaseId: () => "lease-b",
    }),
  ]);

  const acquired = [left, right].filter((entry) => entry.acquired);
  const denied = [left, right].filter((entry) => !entry.acquired);
  assert.equal(acquired.length, 1);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].reason, "bootstrap_in_progress");
  assert.equal(denied[0].leaseToken, null);

  const paths = egoBootstrapLeasePaths(transportStateDir);
  const raw = await readFile(paths.record, "utf8");
  assert.doesNotMatch(raw, /lease-token-[ab]-0123456789/);
  const record = JSON.parse(raw);
  assert.match(record.tokenSha256, /^[a-f0-9]{64}$/);
  assert.equal(record.status, "active");
  assert.equal(record.generation, 1);
  assert.equal((await stat(paths.record)).mode & 0o777, 0o600);
});

test("the exact Ego bootstrap owner can renew and release its capability", async () => {
  const transportStateDir = await tempDir("codex-chat-ego-owner-");
  const acquired = await egoBootstrapLease({
    action: "acquire",
    transportStateDir,
    owner: OWNER_A,
    ttlMs: 60_000,
    clock: fixedClock("2026-08-01T01:00:00.000Z"),
    createToken: () => "lease-token-a-0123456789",
    createLeaseId: () => "lease-a",
  });

  const renewed = await egoBootstrapLease({
    action: "renew",
    transportStateDir,
    owner: OWNER_A,
    leaseId: acquired.leaseId,
    leaseToken: acquired.leaseToken,
    ttlMs: 120_000,
    clock: fixedClock("2026-08-01T01:00:30.000Z"),
  });
  assert.equal(renewed.acquired, true);
  assert.equal(renewed.reason, "bootstrap_renewed");
  assert.equal(renewed.expiresAt, "2026-08-01T01:02:30.000Z");
  assert.equal(renewed.generation, 1);

  const released = await egoBootstrapLease({
    action: "release",
    transportStateDir,
    owner: OWNER_A,
    leaseId: acquired.leaseId,
    leaseToken: acquired.leaseToken,
    clock: fixedClock("2026-08-01T01:00:40.000Z"),
  });
  assert.equal(released.acquired, false);
  assert.equal(released.reason, "bootstrap_released");
  assert.equal(released.leaseToken, null);

  const record = JSON.parse(
    await readFile(egoBootstrapLeasePaths(transportStateDir).record, "utf8"),
  );
  assert.equal(record.status, "released");
  assert.equal(record.tokenSha256, null);
});

test("mismatched owners and capabilities cannot renew or release an Ego bootstrap lease", async () => {
  const transportStateDir = await tempDir("codex-chat-ego-mismatch-");
  const acquired = await egoBootstrapLease({
    action: "acquire",
    transportStateDir,
    owner: OWNER_A,
    clock: fixedClock("2026-08-01T01:00:00.000Z"),
    createToken: () => "lease-token-a-0123456789",
    createLeaseId: () => "lease-a",
  });

  await assert.rejects(
    egoBootstrapLease({
      action: "renew",
      transportStateDir,
      owner: OWNER_B,
      leaseId: acquired.leaseId,
      leaseToken: acquired.leaseToken,
      clock: fixedClock("2026-08-01T01:00:10.000Z"),
    }),
    { code: "EGO_BOOTSTRAP_LEASE_MISMATCH" },
  );
  await assert.rejects(
    egoBootstrapLease({
      action: "release",
      transportStateDir,
      owner: OWNER_A,
      leaseId: acquired.leaseId,
      leaseToken: "wrong-token-0123456789",
      clock: fixedClock("2026-08-01T01:00:10.000Z"),
    }),
    { code: "EGO_BOOTSTRAP_LEASE_MISMATCH" },
  );
});

test("Ego bootstrap actions reject capability and TTL fields they cannot consume", async () => {
  const transportStateDir = await tempDir("codex-chat-ego-inputs-");
  await assert.rejects(
    egoBootstrapLease({
      action: "acquire",
      transportStateDir,
      owner: OWNER_A,
      leaseId: "caller-lease",
      leaseToken: "caller-token-0123456789",
    }),
    { code: "EGO_BOOTSTRAP_LEASE_INPUT_INVALID" },
  );
  await assert.rejects(
    egoBootstrapLease({
      action: "release",
      transportStateDir,
      owner: OWNER_A,
      leaseId: "caller-lease",
      leaseToken: "caller-token-0123456789",
      ttlMs: 60_000,
    }),
    { code: "EGO_BOOTSTRAP_LEASE_INPUT_INVALID" },
  );
});

test("an expired lease can be replaced by a new generation while its old capability stays stale", async () => {
  const transportStateDir = await tempDir("codex-chat-ego-expiry-");
  const first = await egoBootstrapLease({
    action: "acquire",
    transportStateDir,
    owner: OWNER_A,
    ttlMs: 60_000,
    clock: fixedClock("2026-08-01T01:00:00.000Z"),
    createToken: () => "lease-token-a-0123456789",
    createLeaseId: () => "lease-a",
  });
  const second = await egoBootstrapLease({
    action: "acquire",
    transportStateDir,
    owner: OWNER_B,
    ttlMs: 60_000,
    clock: fixedClock("2026-08-01T01:01:00.000Z"),
    createToken: () => "lease-token-b-0123456789",
    createLeaseId: () => "lease-b",
  });

  assert.equal(second.acquired, true);
  assert.equal(second.reason, "expired_bootstrap_replaced");
  assert.equal(second.generation, 2);
  assert.notEqual(second.leaseId, first.leaseId);

  await assert.rejects(
    egoBootstrapLease({
      action: "release",
      transportStateDir,
      owner: OWNER_A,
      leaseId: first.leaseId,
      leaseToken: first.leaseToken,
      clock: fixedClock("2026-08-01T01:01:01.000Z"),
    }),
    { code: "EGO_BOOTSTRAP_LEASE_MISMATCH" },
  );
});

test("Ego bootstrap state rejects symlinked records and shared directories", async () => {
  const symlinkStateDir = await tempDir("codex-chat-ego-symlink-");
  const outside = path.join(
    await tempDir("codex-chat-ego-outside-"),
    "lease.json",
  );
  const symlinkPaths = egoBootstrapLeasePaths(symlinkStateDir);
  await symlink(outside, symlinkPaths.record);

  await assert.rejects(
    egoBootstrapLease({
      action: "acquire",
      transportStateDir: symlinkStateDir,
      owner: OWNER_A,
      clock: fixedClock("2026-08-01T01:00:00.000Z"),
      createToken: () => "lease-token-a-0123456789",
      createLeaseId: () => "lease-a",
    }),
    { code: "EGO_BOOTSTRAP_LEASE_STATE_INVALID" },
  );
  await assert.rejects(readFile(outside, "utf8"), { code: "ENOENT" });

  const sharedStateDir = await tempDir("codex-chat-ego-shared-");
  const sharedPaths = egoBootstrapLeasePaths(sharedStateDir);
  await chmod(sharedPaths.root, 0o755);
  await assert.rejects(
    egoBootstrapLease({
      action: "acquire",
      transportStateDir: sharedStateDir,
      owner: OWNER_A,
      clock: fixedClock("2026-08-01T01:00:00.000Z"),
      createToken: () => "lease-token-a-0123456789",
      createLeaseId: () => "lease-a",
    }),
    { code: "EGO_BOOTSTRAP_LEASE_DIRECTORY_INVALID" },
  );
  assert.equal((await stat(sharedPaths.root)).mode & 0o777, 0o755);
});

test("the installed CLI exposes the bounded Ego bootstrap capability workflow", async () => {
  const transportStateDir = await tempDir("codex-chat-ego-cli-");
  const ownerArgs = [
    "--workspace-id", "workspace-cli",
    "--coordinator-id", "coordinator-cli",
    "--work-unit-id", "work-unit-cli",
    "--agent-id", "agent-cli",
    "--attempt-id", "attempt-cli",
  ];
  const acquired = await runCli([
    "ego-bootstrap-lease",
    "--action", "acquire",
    "--transport-state-dir", transportStateDir,
    "--ttl-ms", "60000",
    ...ownerArgs,
  ]);
  assert.equal(acquired.code, 0);
  assert.equal(acquired.json.ok, true);
  assert.equal(acquired.json.command, "ego-bootstrap-lease");
  assert.equal(acquired.json.data.acquired, true);
  assert.equal(typeof acquired.json.data.leaseToken, "string");

  const released = await runCli([
    "ego-bootstrap-lease",
    "--action", "release",
    "--transport-state-dir", transportStateDir,
    "--lease-id", acquired.json.data.leaseId,
    "--lease-token", acquired.json.data.leaseToken,
    ...ownerArgs,
  ]);
  assert.equal(released.code, 0);
  assert.equal(released.json.data.reason, "bootstrap_released");
  assert.equal(released.json.data.leaseToken, null);
});
