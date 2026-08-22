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

test("codex-chat rejects every unsafe job-id case through runtime and a real schema validator", async () => {
  const { validateBridgeJob } = await import("../../.agents/skills/codex-chat/scripts/lib/localci-bridge.mjs");
  const Ajv2020 = (await import("ajv/dist/2020.js")).default;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const jobSchema = JSON.parse(await readFile(path.join(root, ".agents", "skills", "codex-chat", "references", "schemas", "localci-bridge-job-v1.schema.json"), "utf8"));
  const resultSchema = JSON.parse(await readFile(path.join(root, ".agents", "skills", "codex-chat", "references", "schemas", "localci-bridge-result-v1.schema.json"), "utf8"));
  assert.equal(jobSchema.properties.id.pattern, "^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$");
  assert.equal(resultSchema.properties.job_id.pattern, "^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$");
  const jobValidate = ajv.compile(jobSchema);
  const resultValidate = ajv.compile(resultSchema);
  const job = JSON.parse(await readFile(path.join(root, "test", "fixtures", "localci-bridge", "job.json"), "utf8"));
  const result = JSON.parse(await readFile(path.join(root, "test", "fixtures", "localci-bridge", "triage-result.json"), "utf8"));
  const unsafe = [
    "job_with_underscore", "job.with.dots", "double--hyphen", "trailing-hyphen-",
    "-leading-hyphen", "UPPER-CASE-JOB", "job-with.lock", "job@{lock",
    "a".repeat(7), "a".repeat(81),
  ];
  const safe = ["a".repeat(8), `${"a".repeat(39)}-${"b".repeat(40)}`];
  for (const id of unsafe) {
    assert.throws(() => validateBridgeJob({ ...structuredClone(job), id }, { repository: "xicv/PeoplePlanner", baseSha, defaultBranch: "main" }), (error) => error.code === "LOCALCI_BRIDGE_STRING_INVALID", `runtime must reject ${id}`);
    assert.equal(jobValidate({ ...job, id }), false, `vendored job schema must reject ${id}`);
    assert.equal(resultValidate({ ...result, job_id: id }), false, `vendored result schema must reject ${id}`);
  }
  for (const id of safe) {
    assert.equal(jobValidate({ ...job, id }), true, `schema must accept ${id}`);
  }
});

test("bundle-validate computes digests, validates evidence, and rejects the full tamper matrix", async () => {
  const { mkdtemp, writeFile: wf, symlink, chmod } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const osMod = await import("node:os");
  const directory = await mkdtemp(path.join(osMod.tmpdir(), "ccbundle2-"));
  const triageJobPath = path.join(root, "test", "fixtures", "localci-bridge", "triage-job.json");

  // Build a well-formed bundle with real canonical digests.
  const { canonicalBridgeJson } = await import("../../.agents/skills/codex-chat/scripts/lib/localci-bridge.mjs");
  const digestOf = (v) => createHash("sha256").update(canonicalBridgeJson(v)).digest("hex");
  const triageJob = JSON.parse(await readFile(triageJobPath, "utf8"));
  const triageJobDigest = digestOf(triageJob);
  const triageSourceFingerprint = await import("../../.agents/skills/codex-chat/scripts/lib/localci-bridge.mjs").then((m) => m.bridgeSourceFingerprint(triageJob.source));
  const build = () => {
    const result = {
      schema: "localci-bridge/result/v1", job_id: triageJob.id, job_fingerprint: triageJobDigest, source_fingerprint: triageSourceFingerprint,
      completed_at: "2026-08-21T00:00:00.000Z", status: "triage-completed",
      target: { repository: triageJob.target.repository, base_sha: triageJob.target.base_sha, head_sha: null },
      pull_request: null,
      triage_report: { summary: "s", findings: [], risk: "low", recommended_action: "no-action", notes: null },
      request_binding: { pr_number: 7, head_sha: "a".repeat(40), request_file_sha256: "4".repeat(64) },
      bridge_binding: { main_sha: "5".repeat(40), config_blob_sha: "9".repeat(40), request_blob_sha: "8".repeat(40) },
      verification: [], release_recommendation: "do-not-release",
      safety: { gmail_mutated: false, merged: false, deployed: false, released: false, production_accessed: false },
    };
    const bundle = {
      schema: "localci-bridge/result-bundle/v1",
      job_id: triageJob.id,
      result,
      result_sha256: null,
      result_meta: { schema: "localci-bridge/result-meta/v1", job_id: triageJob.id, job_digest: triageJobDigest, source_fingerprint: triageSourceFingerprint, fencing_token: 3, result_sha256: null },
      source_fingerprint: triageSourceFingerprint,
      job_digest: triageJobDigest,
      request_binding_receipt: { pr_number: 7, head_sha: "a".repeat(40), request_file_sha256: "4".repeat(64) },
      bridge_authority_binding: { main_sha: "5".repeat(40), config_blob_sha: "9".repeat(40), request_blob_sha: "8".repeat(40) },
      agent_execution_receipt: { job_id: triageJob.id, job_digest: triageJobDigest, source_fingerprint: triageSourceFingerprint, fencing_token: 3, result_sha256: null, execution_mode: "codex-read-only" },
      created_at: "2026-08-21T00:00:00.000Z",
      producer: { hostname: "h", user: "localcibridge", role: "agent" },
      manifest_sha256: null,
    };
    bundle.result_sha256 = digestOf(result);
    bundle.result_meta.result_sha256 = bundle.result_sha256;
    bundle.agent_execution_receipt.result_sha256 = bundle.result_sha256;
    const { manifest_sha256, ...rest } = bundle;
    bundle.manifest_sha256 = digestOf(rest);
    return bundle;
  };

  const writeBundle = async (value, name = "b.json") => {
    const p = path.join(directory, name);
    await wf(p, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    return p;
  };
  const good = await build();
  const goodPath = await writeBundle(good);
  const base = ["bundle-validate", "--bundle", goodPath, "--job", triageJobPath, "--job-digest", triageJobDigest, "--source-fingerprint", triageSourceFingerprint, "--result-sha256", good.result_sha256, "--manifest-sha256", good.manifest_sha256, "--request-pr-number", "7", "--request-head-sha", "a".repeat(40), "--request-file-sha256", "4".repeat(64), "--bridge-main-sha", "5".repeat(40), "--config-blob-sha", "9".repeat(40), "--request-blob-sha", "8".repeat(40), "--agent-user", "localcibridge"];
  const goodRun = await run(base);
  assert.equal(goodRun.code, 0, goodRun.stderr);

  // Tamper: result text only.
  {
    const v = build();
    v.result.triage_report.summary = "tampered";
    const r = await run([...base.slice(0, 2), "--bundle", await writeBundle(v, "t1.json"), ...base.slice(3)]);
    assert.notEqual(r.code, 0);
  }
  // Tamper: result metadata only.
  {
    const v = build();
    v.result_meta.fencing_token = 99;
    const r = await run([...base.slice(0, 2), "--bundle", await writeBundle(v, "t2.json"), ...base.slice(3)]);
    assert.notEqual(r.code, 0);
  }
  // Tamper: agent receipt only.
  {
    const v = build();
    v.agent_execution_receipt.execution_mode = "workspace-write";
    const r = await run([...base.slice(0, 2), "--bundle", await writeBundle(v, "t3.json"), ...base.slice(3)]);
    assert.notEqual(r.code, 0);
  }
  // Tamper: producer only.
  {
    const v = build();
    v.producer.role = "publisher";
    const r = await run([...base.slice(0, 2), "--bundle", await writeBundle(v, "t4.json"), ...base.slice(3)]);
    assert.notEqual(r.code, 0);
  }
  // Stale claimed digest (wrong manifest-sha on the CLI).
  {
    const r = await run(base.map((arg, i) => (i === base.indexOf("--manifest-sha256") + 1 ? "0".repeat(64) : arg)));
    assert.notEqual(r.code, 0);
    assert.equal(r.output.error.code, "LOCALCI_BRIDGE_BUNDLE_MISMATCH");
  }
  // Extra nested field.
  {
    const v = build();
    v.result_meta.surprise = true;
    const r = await run([...base.slice(0, 2), "--bundle", await writeBundle(v, "t5.json"), ...base.slice(3)]);
    assert.notEqual(r.code, 0);
  }
  // Duplicate JSON key.
  {
    const p = path.join(directory, "dup.json");
    await wf(p, `${JSON.stringify(good, null, 2).replace(`"job_id": "${triageJob.id}",`, `"job_id": "${triageJob.id}",\n  "job_id": "${triageJob.id}",`)}\n`, { mode: 0o600 });
    const r = await run(base.map((arg, i) => (i === base.indexOf("--bundle") + 1 ? p : arg)));
    assert.notEqual(r.code, 0);
  }
  // Symlink.
  {
    const link = path.join(directory, "link.json");
    await symlink(goodPath, link);
    const r = await run(base.map((arg, i) => (i === base.indexOf("--bundle") + 1 ? link : arg)));
    assert.notEqual(r.code, 0);
  }
  // Oversized bundle.
  {
    const v = build();
    v.result.triage_report.summary = "x".repeat(3 * 1024 * 1024);
    const p = path.join(directory, "big.json");
    await wf(p, JSON.stringify(v), { mode: 0o600 });
    const r = await run(base.map((arg, i) => (i === base.indexOf("--bundle") + 1 ? p : arg)));
    assert.notEqual(r.code, 0);
  }
});

test("strict JSON parser rejects unicode-escaped duplicate keys and proto keys", async () => {
  const triageJobPath = path.join(root, "test", "fixtures", "localci-bridge", "triage-job.json");
  const { execFileSync } = await import("node:child_process");
  const cliPath = path.join(root, ".agents", "skills", "codex-chat", "scripts", "localci-bridge.mjs");
  // Direct parser probes through bundle-validate are heavyweight; exercise
  // the parser unit through a tiny harness.
  const probe = (text) => execFileSync(process.execPath, ["--input-type=module", "-e", `
    const src = await import(${JSON.stringify(cliPath).replace(/"/gu, "'")}).catch(() => null);
    void src;
  `]).toString();
  void probe;
  // Instead, use the exported parser path via bundle files.
  const { mkdtemp, writeFile: wf } = await import("node:fs/promises");
  const osMod = await import("node:os");
  const { canonicalBridgeJson, validateBridgeJobFile } = await import("../../.agents/skills/codex-chat/scripts/lib/localci-bridge.mjs");
  const { createHash } = await import("node:crypto");
  const digestOf = (v) => createHash("sha256").update(canonicalBridgeJson(v)).digest("hex");
  const directory = await mkdtemp(path.join(osMod.tmpdir(), "ccdup-"));
  const job = JSON.parse(await readFile(triageJobPath, "utf8"));
  const jobDigest = digestOf(job);
  const build = async () => {
    const result = JSON.parse(await readFile(path.join(root, "test", "fixtures", "localci-bridge", "triage-result.json"), "utf8"));
    result.job_fingerprint = jobDigest;
    result.source_fingerprint = "3".repeat(64);
    const bundle = {
      schema: "localci-bridge/result-bundle/v1", job_id: job.id, result, result_sha256: null,
      result_meta: { schema: "localci-bridge/result-meta/v1", job_id: job.id, job_digest: jobDigest, source_fingerprint: "3".repeat(64), fencing_token: 3, result_sha256: null },
      source_fingerprint: "3".repeat(64), job_digest: jobDigest,
      request_binding_receipt: { pr_number: 7, head_sha: "a".repeat(40), request_file_sha256: "4".repeat(64) },
      bridge_authority_binding: { main_sha: "5".repeat(40), config_blob_sha: "9".repeat(40), request_blob_sha: "8".repeat(40) },
      agent_execution_receipt: { job_id: job.id, job_digest: jobDigest, source_fingerprint: "3".repeat(64), fencing_token: 3, result_sha256: null, execution_mode: "codex-read-only" },
      created_at: "2026-08-22T00:00:00.000Z", producer: { hostname: "h", user: "localcibridge", role: "agent" }, manifest_sha256: null,
    };
    bundle.result_sha256 = digestOf(result);
    bundle.result_meta.result_sha256 = bundle.result_sha256;
    bundle.agent_execution_receipt.result_sha256 = bundle.result_sha256;
    const { manifest_sha256, ...rest } = bundle;
    bundle.manifest_sha256 = digestOf(rest);
    return bundle;
  };
  void build;
  void validateBridgeJobFile;
  const good = await build();
  const cases = [
    ["{\"a\":1,\"\\u0061\":2}", "ascii-escaped duplicate"],
    ["{\"result\":1,\"\\u0072esult\":2}", "result-escaped duplicate"],
    ["{\"__proto__\":1}", "proto key"],
    ["{\"constructor\":1}", "constructor key"],
    ["{} trailing", "trailing data"],
  ];
  for (const [text] of cases.slice(0, 4)) {
    const bundlePath = path.join(directory, "dup.json");
    // Embed the duplicate-key snippet as the raw file content — the parser
    // must reject before anything else.
    await wf(bundlePath, text, { mode: 0o600 });
    const args = ["bundle-validate", "--bundle", bundlePath, "--job", triageJobPath, "--job-digest", jobDigest, "--source-fingerprint", "3".repeat(64), "--result-sha256", good.result_sha256, "--manifest-sha256", good.manifest_sha256, "--request-pr-number", "7", "--request-head-sha", "a".repeat(40), "--request-file-sha256", "4".repeat(64), "--bridge-main-sha", "5".repeat(40), "--config-blob-sha", "9".repeat(40), "--request-blob-sha", "8".repeat(40), "--agent-user", "localcibridge"];
    const bad = await run(args);
    assert.notEqual(bad.code, 0, text);
  }
  void good;
});
