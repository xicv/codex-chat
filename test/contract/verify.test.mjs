import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runVerification } from "../../.agents/skills/codex-chat/scripts/lib/verify.mjs";
import { tempDir, writeFixture } from "../helpers.mjs";

test("runVerification executes a digest-pinned argv plan without a shell", async () => {
  const root = await tempDir();
  const sourceRoot = await tempDir();
  const evidenceDir = path.join(await tempDir(), "evidence");
  const marker = path.join(root, "must-not-exist");
  const script = await writeFixture(
    root,
    "print-args.mjs",
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
  );
  const plan = {
    kind: "CODEX_CHAT_VERIFY_V1",
    protocolVersion: 1,
    cwd: root,
    sourceRoot,
    scratchRoot: root,
    argv: [process.execPath, script, `$(touch ${marker})`, ";", "echo"],
    timeoutMs: 5_000,
    evidenceClass: "local-synthetic",
  };
  const planPath = path.join(root, "plan.json");
  const planContents = `${JSON.stringify(plan)}\n`;
  await writeFile(planPath, planContents);

  const result = await runVerification({
    planPath,
    evidenceDir,
    expectedPlanSha256: createHash("sha256").update(planContents).digest("hex"),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.evidenceClass, "local-synthetic");
  assert.equal(await access(marker).then(() => true, () => false), false);
  assert.deepEqual(
    JSON.parse(await readFile(result.stdoutPath, "utf8")),
    [`$(touch ${marker})`, ";", "echo"],
  );
  assert.match(result.planSha256, /^[a-f0-9]{64}$/);
  assert.match(result.stdoutSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.resolvedExecutable, process.execPath);
  assert.match(result.environmentFingerprint, /^[a-f0-9]{64}$/);
  assert.match(result.executionDigest, /^[a-f0-9]{64}$/);
  assert.equal(await access(result.receiptPath).then(() => true, () => false), true);

  const rerun = await runVerification({
    planPath,
    evidenceDir,
    expectedPlanSha256: result.planSha256,
  });
  assert.notEqual(rerun.executionDigest, result.executionDigest);
  assert.notEqual(rerun.stdoutPath, result.stdoutPath);
});

test("runVerification escalates an ignored timeout to bounded termination", async () => {
  const scratchRoot = await tempDir();
  const sourceRoot = await tempDir();
  const script = await writeFixture(
    scratchRoot,
    "ignore-term.mjs",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
  );
  const plan = {
    kind: "CODEX_CHAT_VERIFY_V1",
    protocolVersion: 1,
    cwd: scratchRoot,
    sourceRoot,
    scratchRoot,
    argv: [process.execPath, script],
    timeoutMs: 300,
    evidenceClass: "local-synthetic",
  };
  const contents = `${JSON.stringify(plan)}\n`;
  const planPath = path.join(await tempDir(), "timeout.json");
  await writeFile(planPath, contents);
  const started = Date.now();
  const result = await runVerification({
    planPath,
    evidenceDir: path.join(await tempDir(), "evidence"),
    expectedPlanSha256: createHash("sha256").update(contents).digest("hex"),
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.ok(Date.now() - started < 2_000);
});

test("runVerification rejects a changed plan digest", async () => {
  const root = await tempDir();
  const sourceRoot = await tempDir();
  const planPath = path.join(root, "plan.json");
  await writeFile(planPath, `${JSON.stringify({
    kind: "CODEX_CHAT_VERIFY_V1",
    protocolVersion: 1,
    cwd: root,
    sourceRoot,
    scratchRoot: root,
    argv: [process.execPath, "--version"],
    timeoutMs: 5_000,
    evidenceClass: "local-synthetic",
  })}\n`);
  await assert.rejects(
    runVerification({
      planPath,
      evidenceDir: path.join(await tempDir(), "evidence"),
      expectedPlanSha256: "0".repeat(64),
    }),
    (error) => error.code === "VERIFY_PLAN_DIGEST_MISMATCH",
  );
});

test("runVerification rejects explicit shells and cwd outside the authorised scratch", async (t) => {
  const sourceRoot = await tempDir();
  const scratchRoot = await tempDir();
  const cases = [
    ["shell", scratchRoot, ["/bin/sh", "-c", "exit 0"], "VERIFY_EXECUTABLE_POLICY"],
    ["cwd", sourceRoot, [process.execPath, "--version"], "VERIFY_CWD_OUTSIDE_SCRATCH"],
  ];
  for (const [name, cwd, argv, code] of cases) {
    await t.test(name, async () => {
      const plan = {
        kind: "CODEX_CHAT_VERIFY_V1",
        protocolVersion: 1,
        cwd,
        sourceRoot,
        scratchRoot,
        argv,
        timeoutMs: 5_000,
        evidenceClass: "local-synthetic",
      };
      const contents = `${JSON.stringify(plan)}\n`;
      const planPath = path.join(await tempDir(), `${name}.json`);
      await writeFile(planPath, contents);
      await assert.rejects(
        runVerification({
          planPath,
          evidenceDir: path.join(await tempDir(), "evidence"),
          expectedPlanSha256: createHash("sha256").update(contents).digest("hex"),
        }),
        (error) => error.code === code,
      );
    });
  }
});

test("runVerification rejects shell dispatchers and evidence nested in source or scratch", async (t) => {
  const sourceRoot = await tempDir();
  const scratchRoot = await tempDir();
  const cases = [
    [
      "dispatcher",
      ["/usr/bin/env", "sh", "-c", "exit 0"],
      path.join(await tempDir(), "evidence"),
      "VERIFY_EXECUTABLE_POLICY",
    ],
    [
      "evidence-source",
      [process.execPath, "--version"],
      path.join(sourceRoot, "evidence"),
      "VERIFY_EVIDENCE_CONFINEMENT",
    ],
    [
      "evidence-scratch",
      [process.execPath, "--version"],
      path.join(scratchRoot, "evidence"),
      "VERIFY_EVIDENCE_CONFINEMENT",
    ],
  ];
  for (const [name, argv, evidenceDir, code] of cases) {
    await t.test(name, async () => {
      const plan = {
        kind: "CODEX_CHAT_VERIFY_V1",
        protocolVersion: 1,
        cwd: scratchRoot,
        sourceRoot,
        scratchRoot,
        argv,
        timeoutMs: 5_000,
        evidenceClass: "local-synthetic",
      };
      const contents = `${JSON.stringify(plan)}\n`;
      const planPath = path.join(await tempDir(), `${name}.json`);
      await writeFile(planPath, contents);
      await assert.rejects(
        runVerification({
          planPath,
          evidenceDir,
          expectedPlanSha256: createHash("sha256").update(contents).digest("hex"),
        }),
        (error) => error.code === code,
      );
    });
  }
});
