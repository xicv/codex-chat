import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bridgeDigest,
  validateBridgeJob,
  validateBridgeJobFile,
  validateBridgeResult,
} from "../../.agents/skills/codex-chat/scripts/lib/localci-bridge.mjs";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const jobPath = path.join(root, "test", "fixtures", "localci-bridge", "job.json");
const resultPath = path.join(root, "test", "fixtures", "localci-bridge", "result.json");
const expectations = {
  repository: "xicv/PeoplePlanner",
  baseSha: "d9fe027113486bc31d311d7c7dfffea4749bced4",
  defaultBranch: "main",
};

async function json(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("validates the exact PeoplePlanner bridge job and canonical digest", async () => {
  const result = await validateBridgeJobFile(jobPath, expectations);
  assert.equal(result.valid, true);
  assert.equal(result.jobId, "pp-20260819-shift-filter");
  assert.equal(
    result.digest,
    "a4e63ea353630df6e1a5a6dda94ce3836574ec69ac2187350eab6f7bf288ca97",
  );
});

test("job validation rejects a different independent base SHA", async () => {
  await assert.rejects(
    validateBridgeJobFile(jobPath, {
      ...expectations,
      baseSha: "0".repeat(40),
    }),
    { code: "LOCALCI_BRIDGE_TARGET_MISMATCH" },
  );
});

test("job validation rejects merge authority and protected paths", async () => {
  const value = await json(jobPath);
  value.publish.merge = true;
  assert.throws(
    () => validateBridgeJob(value, expectations),
    { code: "LOCALCI_BRIDGE_PUBLICATION_INVALID" },
  );

  const pathValue = await json(jobPath);
  pathValue.allowed_paths = ["deployment/release.sh"];
  assert.throws(
    () => validateBridgeJob(pathValue, expectations),
    { code: "LOCALCI_BRIDGE_PATH_INVALID" },
  );
});

test("job validation rejects raw Gmail identifiers and secret-like text", async () => {
  const value = await json(jobPath);
  value.instructions = "thread_id: raw-mailbox-value";
  assert.throws(
    () => validateBridgeJob(value, expectations),
    { code: "LOCALCI_BRIDGE_SENSITIVE_TEXT" },
  );
});

test("trusted snapshot boundary rejects a symlinked job", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-chat-bridge-"));
  try {
    const target = path.join(directory, "job.json");
    const link = path.join(directory, "link.json");
    await writeFile(target, await readFile(jobPath));
    await symlink(target, link);
    await assert.rejects(
      validateBridgeJobFile(link, expectations),
      { code: "TRUSTED_FILE_PATH_INVALID" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validates a result against independent PR identity without authorizing action", async () => {
  const job = await validateBridgeJobFile(jobPath, expectations);
  const result = validateBridgeResult(
    await json(resultPath),
    job,
    {
      headSha: "1".repeat(40),
      pullRequestNumber: 123,
    },
  );
  assert.equal(result.valid, true);
  assert.equal(result.actionAuthorized, false);
  assert.equal(result.mergeAuthorized, false);
  assert.equal(result.releaseAuthorized, false);
});

test("result validation rejects a moved head and non-draft PR", async () => {
  const job = await validateBridgeJobFile(jobPath, expectations);
  const value = await json(resultPath);
  assert.throws(
    () => validateBridgeResult(value, job, {
      headSha: "2".repeat(40),
      pullRequestNumber: 123,
    }),
    { code: "LOCALCI_BRIDGE_RESULT_HEAD_MISMATCH" },
  );
  value.pull_request.draft = false;
  assert.throws(
    () => validateBridgeResult(value, job, {
      headSha: "1".repeat(40),
      pullRequestNumber: 123,
    }),
    { code: "LOCALCI_BRIDGE_RESULT_PR_INVALID" },
  );
});

test("bridge digest is independent of object insertion order", () => {
  assert.equal(
    bridgeDigest({ z: 2, a: 1 }),
    bridgeDigest({ a: 1, z: 2 }),
  );
});

test("triage results embed a complete sanitized report and reject unsafe ones", async () => {
  const triageJobPath = path.join(root, "test", "fixtures", "localci-bridge", "triage-job.json");
  const triageResultPath = path.join(root, "test", "fixtures", "localci-bridge", "triage-result.json");
  const triageExpectations = {
    repository: "xicv/PeoplePlanner",
    baseSha: "d9fe027113486bc31d311d7c7dfffea4749bced4",
    defaultBranch: "main",
  };
  const triageJob = await validateBridgeJobFile(triageJobPath, triageExpectations);
  const value = await json(triageResultPath);
  const checked = validateBridgeResult(value, triageJob, {});
  assert.equal(checked.valid, true);
  assert.equal(checked.result.status, "triage-completed");
  assert.equal(checked.actionAuthorized, false);

  const missing = JSON.parse(JSON.stringify(value));
  missing.triage_report = null;
  assert.throws(
    () => validateBridgeResult(missing, triageJob, {}),
    { code: "LOCALCI_BRIDGE_TRIAGE_INVALID" },
  );

  const malformed = JSON.parse(JSON.stringify(value));
  delete malformed.triage_report.findings[0].confidence;
  assert.throws(
    () => validateBridgeResult(malformed, triageJob, {}),
    { code: "LOCALCI_BRIDGE_KEYS_INVALID" },
  );

  const oversized = JSON.parse(JSON.stringify(value));
  oversized.triage_report.findings = Array.from({ length: 31 }, () => value.triage_report.findings[0]);
  assert.throws(
    () => validateBridgeResult(oversized, triageJob, {}),
    { code: "LOCALCI_BRIDGE_TRIAGE_INVALID" },
  );

  const leaked = JSON.parse(JSON.stringify(value));
  leaked.triage_report.summary = "Sent the analysis to ops@example.com yesterday.";
  assert.throws(
    () => validateBridgeResult(leaked, triageJob, {}),
    { code: "LOCALCI_BRIDGE_SENSITIVE_TEXT" },
  );

  const phoned = JSON.parse(JSON.stringify(value));
  phoned.triage_report.notes = "Call the reporter on +61 8 8123 4567 for details.";
  assert.throws(
    () => validateBridgeResult(phoned, triageJob, {}),
    { code: "LOCALCI_BRIDGE_SENSITIVE_TEXT" },
  );

  // A draft-PR result may never carry a triage report.
  const draftJob = await validateBridgeJobFile(jobPath, expectations);
  const draftResult = await json(resultPath);
  const smuggled = JSON.parse(JSON.stringify(draftResult));
  smuggled.triage_report = value.triage_report;
  assert.throws(
    () => validateBridgeResult(smuggled, draftJob, {
      headSha: "1".repeat(40),
      pullRequestNumber: 123,
    }),
    { code: "LOCALCI_BRIDGE_TRIAGE_INVALID" },
  );
});

test("results carry the merged request binding and reject bad bindings", async () => {
  const triageJobPath = path.join(root, "test", "fixtures", "localci-bridge", "triage-job.json");
  const triageResultPath = path.join(root, "test", "fixtures", "localci-bridge", "triage-result.json");
  const triageExpectations = {
    repository: "xicv/PeoplePlanner",
    baseSha: "d9fe027113486bc31d311d7c7dfffea4749bced4",
    defaultBranch: "main",
  };
  const triageJob = await validateBridgeJobFile(triageJobPath, triageExpectations);
  const value = await json(triageResultPath);
  const checked = validateBridgeResult(value, triageJob, {});
  assert.equal(checked.valid, true);
  assert.ok(Number.isInteger(checked.result.request_binding.pr_number));
  assert.match(checked.result.request_binding.head_sha, /^[0-9a-f]{40}$/u);
  assert.match(checked.result.request_binding.request_file_sha256, /^[a-f0-9]{64}$/u);

  const missing = JSON.parse(JSON.stringify(value));
  delete missing.request_binding;
  assert.throws(() => validateBridgeResult(missing, triageJob, {}), { code: "LOCALCI_BRIDGE_KEYS_INVALID" });

  const malformed = JSON.parse(JSON.stringify(value));
  malformed.request_binding.head_sha = "short";
  assert.throws(() => validateBridgeResult(malformed, triageJob, {}), { code: "LOCALCI_BRIDGE_STRING_INVALID" });

  const extra = JSON.parse(JSON.stringify(value));
  extra.request_binding.surprise = true;
  assert.throws(() => validateBridgeResult(extra, triageJob, {}), { code: "LOCALCI_BRIDGE_KEYS_INVALID" });
});
