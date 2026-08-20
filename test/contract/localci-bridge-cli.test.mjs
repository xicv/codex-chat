import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(
  root,
  ".agents",
  "skills",
  "codex-chat",
  "scripts",
  "localci-bridge.mjs",
);
const baseSha = "d9fe027113486bc31d311d7c7dfffea4749bced4";

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      let output = null;
      try { output = JSON.parse(stdout); } catch { output = { raw: stdout, errRaw: stderr }; }
      resolve({ code, output, stderr });
    });
  });
}

test("job-validate emits the codex-chat CLI envelope", async () => {
  const result = await run([
    "job-validate",
    "--file", "test/fixtures/localci-bridge/job.json",
    "--repository", "xicv/PeoplePlanner",
    "--base-sha", baseSha,
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.output.schema, "codex-chat/cli/v1");
  assert.equal(result.output.ok, true);
  assert.equal(result.output.command, "job-validate");
  assert.equal(result.output.data.actionAuthorized, undefined);
});

test("result-validate requires all six independent binding values", async () => {
  const result = await run([
    "result-validate",
    "--job", "test/fixtures/localci-bridge/job.json",
    "--result", "test/fixtures/localci-bridge/result.json",
    "--repository", "xicv/PeoplePlanner",
    "--base-sha", baseSha,
    "--head-sha", "1".repeat(40),
    "--pr-number", "123",
  ]);
  assert.equal(result.code, 2);
  assert.equal(result.output.ok, false);
  assert.match(result.output.error.message, /request-pr-number|Missing/u);
});

test("result-validate rejects malformed --request-pr-number values", async () => {
  const base = [
    "result-validate",
    "--job", "test/fixtures/localci-bridge/job.json",
    "--result", "test/fixtures/localci-bridge/result.json",
    "--repository", "xicv/PeoplePlanner",
    "--base-sha", baseSha,
    "--head-sha", "1".repeat(40),
    "--pr-number", "123",
    "--request-head-sha", "1".repeat(40),
    "--request-file-sha256", "2".repeat(64),
    "--bridge-main-sha", "a".repeat(40),
    "--config-blob-sha", "b".repeat(40),
    "--request-blob-sha", "c".repeat(40),
  ];
  for (const bad of ["12junk", "0", "-3", "9007199254740993", "3.5", ""]) {
    const result = await run([...base, "--request-pr-number", bad]);
    assert.notEqual(result.code, 0, `--request-pr-number ${JSON.stringify(bad)} must be rejected`);
    assert.match(result.output.error.message, /positive integer|too large/u);
  }
});

test("result-validate compares independent bindings exactly", async () => {
  const resultValue = JSON.parse(await readFile(path.join(root, "test", "fixtures", "localci-bridge", "result.json"), "utf8"));
  const requestBinding = resultValue.request_binding;
  const bridgeBinding = resultValue.bridge_binding;
  const good = await run([
    "result-validate",
    "--job", "test/fixtures/localci-bridge/job.json",
    "--result", "test/fixtures/localci-bridge/result.json",
    "--repository", "xicv/PeoplePlanner",
    "--base-sha", baseSha,
    "--head-sha", "1".repeat(40),
    "--pr-number", "123",
    "--request-pr-number", String(requestBinding.pr_number),
    "--request-head-sha", requestBinding.head_sha,
    "--request-file-sha256", requestBinding.request_file_sha256,
    "--bridge-main-sha", bridgeBinding.main_sha,
    "--config-blob-sha", bridgeBinding.config_blob_sha,
    "--request-blob-sha", bridgeBinding.request_blob_sha,
  ]);
  assert.equal(good.code, 0, good.stderr);
  assert.equal(good.output.data.pullRequestNumber, 123);
  assert.equal(good.output.data.releaseAuthorized, false);
  assert.deepEqual(good.output.data.independently_bound.request_binding, requestBinding);
  assert.deepEqual(good.output.data.independently_bound.bridge_binding, bridgeBinding);

  const bad = await run([
    "result-validate",
    "--job", "test/fixtures/localci-bridge/job.json",
    "--result", "test/fixtures/localci-bridge/result.json",
    "--repository", "xicv/PeoplePlanner",
    "--base-sha", baseSha,
    "--head-sha", "1".repeat(40),
    "--pr-number", "123",
    "--request-pr-number", String(requestBinding.pr_number),
    "--request-head-sha", "9".repeat(40),
    "--request-file-sha256", requestBinding.request_file_sha256,
    "--bridge-main-sha", bridgeBinding.main_sha,
    "--config-blob-sha", bridgeBinding.config_blob_sha,
    "--request-blob-sha", bridgeBinding.request_blob_sha,
  ]);
  assert.equal(bad.code, 2);
  assert.equal(bad.output.error.code, "BINDING_MISMATCH");

  const badBridge = await run([
    "result-validate",
    "--job", "test/fixtures/localci-bridge/job.json",
    "--result", "test/fixtures/localci-bridge/result.json",
    "--repository", "xicv/PeoplePlanner",
    "--base-sha", baseSha,
    "--head-sha", "1".repeat(40),
    "--pr-number", "123",
    "--request-pr-number", String(requestBinding.pr_number),
    "--request-head-sha", requestBinding.head_sha,
    "--request-file-sha256", requestBinding.request_file_sha256,
    "--bridge-main-sha", "9".repeat(40),
    "--config-blob-sha", bridgeBinding.config_blob_sha,
    "--request-blob-sha", bridgeBinding.request_blob_sha,
  ]);
  assert.equal(badBridge.code, 2);
  assert.equal(badBridge.output.error.code, "BINDING_MISMATCH");
});

test("unknown commands fail closed", async () => {
  const result = await run(["run-shell", "--command", "whoami"]);
  assert.equal(result.code, 2);
  assert.equal(result.output.ok, false);
  assert.equal(result.output.error.code, "UNKNOWN_COMMAND");
});

test("a one-character job id fails codex-chat validation and the vendored schema", async () => {
  const { validateBridgeJob } = await import("../../.agents/skills/codex-chat/scripts/lib/localci-bridge.mjs");
  const job = JSON.parse(await readFile(path.join(root, "test", "fixtures", "localci-bridge", "job.json"), "utf8"));
  job.id = "x";
  assert.throws(
    () => validateBridgeJob(job, { repository: "xicv/PeoplePlanner", baseSha, defaultBranch: "main" }),
    { code: "LOCALCI_BRIDGE_STRING_INVALID" },
  );
  // JSON Schema (draft-2020-12 minLength) via the reference validator walk:
  // the schema's own constraints must reject it too.
  const schema = JSON.parse(await readFile(path.join(root, ".agents", "skills", "codex-chat", "references", "schemas", "localci-bridge-job-v1.schema.json"), "utf8"));
  assert.equal(schema.properties.id.minLength, 8);
  assert.equal(schema.properties.id.maxLength, 80);
  assert.ok(job.id.length < schema.properties.id.minLength, "fixture must be shorter than the schema minimum");
});

test("result-validate requires the trusted-derived source fingerprint", async () => {
  const resultValue = JSON.parse(await readFile(path.join(root, "test", "fixtures", "localci-bridge", "triage-result.json"), "utf8"));
  const requestBinding = resultValue.request_binding;
  const bridgeBinding = resultValue.bridge_binding;
  const base = [
    "result-validate",
    "--job", "test/fixtures/localci-bridge/triage-job.json",
    "--result", "test/fixtures/localci-bridge/triage-result.json",
    "--repository", "xicv/PeoplePlanner",
    "--base-sha", baseSha,
    "--head-sha", "1".repeat(40),
    "--pr-number", "123",
    "--request-pr-number", String(requestBinding.pr_number),
    "--request-head-sha", requestBinding.head_sha,
    "--request-file-sha256", requestBinding.request_file_sha256,
    "--bridge-main-sha", bridgeBinding.main_sha,
    "--config-blob-sha", bridgeBinding.config_blob_sha,
    "--request-blob-sha", bridgeBinding.request_blob_sha,
  ];
  const good = await run(base);
  assert.equal(good.code, 0, good.stderr);

  // A tampered source_fingerprint must be rejected: it must equal the
  // fingerprint recomputed independently from the supplied job source.
  const { mkdtemp, writeFile: wf } = await import("node:fs/promises");
  const osMod = await import("node:os");
  const directory = await mkdtemp(path.join(osMod.tmpdir(), "ccsf-"));
  const tampered = JSON.parse(JSON.stringify(resultValue));
  tampered.source_fingerprint = "0".repeat(64);
  const tamperedPath = path.join(directory, "tampered-result.json");
  await wf(tamperedPath, JSON.stringify(tampered, null, 2) + "\n");
  const bad = await run(base.map((arg, index) => (index === 4 ? tamperedPath : arg)));
  assert.notEqual(bad.code, 0);
  assert.match(bad.output.error.code ?? bad.output.error.message, /SOURCE_FINGERPRINT/u);
});
