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
    "bca738bcd1fef9a60f88c4dee47d973b5324fa877bfdb56dbb26973a1242472f",
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
