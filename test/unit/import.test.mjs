import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, readFile, readdir, symlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import {
  importResult,
  parseResultEnvelope,
} from "../../.agents/skills/codex-chat/scripts/lib/import.mjs";
import { tempDir, writeFixture } from "../helpers.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const execFileAsync = promisify(execFile);

async function boundImport(options) {
  return importResult({
    ...options,
    sourceRoot: options.sourceRoot ?? await tempDir(),
    targetLockDir:
      options.targetLockDir ??
      path.join(path.dirname(options.quarantineDir), "target-locks"),
    expectedRunId: options.envelope.runId,
    expectedTurnId: options.envelope.turnId,
    expectedContextSha256: options.envelope.contextSha256,
  });
}

test("advisory results are validated, scanned, and receipted without a scratch mutation", async () => {
  const sourceRoot = await tempDir();
  const quarantineDir = path.join(await tempDir(), "quarantine");
  const envelope = {
    kind: "COLLAB_RESULT_V1",
    protocolVersion: 1,
    runId: "run-advisory",
    turnId: "turn-advisory",
    contextSha256: sha256("advisory-context"),
    complete: true,
    artifactKind: "advisory",
    summary: "Architecture review with no code change.",
    claims: { findings: [] },
  };

  assert.equal(
    parseResultEnvelope(JSON.stringify(envelope)).artifactKind,
    "advisory",
  );
  const first = await boundImport({
    envelope,
    sourceRoot,
    scratch: null,
    quarantineDir,
    allowedPaths: [],
    scanner: "skip",
    testMode: true,
  });
  assert.equal(first.artifactKind, "advisory");
  assert.equal(first.idempotent, false);
  assert.match(first.resultSha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(first.quarantined, "utf8"), `${JSON.stringify({
    artifactKind: envelope.artifactKind,
    claims: envelope.claims,
    complete: envelope.complete,
    contextSha256: envelope.contextSha256,
    kind: envelope.kind,
    protocolVersion: envelope.protocolVersion,
    runId: envelope.runId,
    summary: envelope.summary,
    turnId: envelope.turnId,
  })}\n`);

  const second = await boundImport({
    envelope,
    sourceRoot,
    scratch: null,
    quarantineDir,
    allowedPaths: [],
    scanner: "skip",
    testMode: true,
  });
  assert.equal(second.idempotent, true);
});

test("advisory import supports a durable legacy run without a source root", async () => {
  const quarantineDir = path.join(await tempDir(), "quarantine");
  const envelope = {
    kind: "COLLAB_RESULT_V1",
    protocolVersion: 1,
    runId: "legacy-advisory",
    turnId: "legacy-turn",
    contextSha256: sha256("legacy-context"),
    complete: true,
    artifactKind: "advisory",
    summary: "Review evidence only.",
    claims: { verdict: "GO" },
  };

  const imported = await importResult({
    envelope,
    sourceRoot: null,
    scratch: null,
    quarantineDir,
    allowedPaths: [],
    expectedRunId: envelope.runId,
    expectedTurnId: envelope.turnId,
    expectedContextSha256: envelope.contextSha256,
    scanner: "skip",
    testMode: true,
  });

  assert.equal(imported.artifactKind, "advisory");
  assert.match(imported.sourceIdentity, /^[a-f0-9]{64}$/);
});

test("parseResultEnvelope and importResult atomically apply one bounded in-scope patch", async () => {
  const scratch = await tempDir();
  const sourceRoot = await tempDir();
  const quarantineDir = path.join(await tempDir(), "quarantine");
  const before = "export const answer = 41;\n";
  const after = "export const answer = 42;\n";
  await writeFixture(scratch, "src/answer.js", before);
  const patch = [
    "--- a/src/answer.js",
    "+++ b/src/answer.js",
    "@@ -1,1 +1,1 @@",
    "-export const answer = 41;",
    "+export const answer = 42;",
    "",
  ].join("\n");
  const envelope = {
    kind: "COLLAB_RESULT_V1",
    protocolVersion: 1,
    runId: "run-1",
    turnId: "turn-1",
    contextSha256: sha256("context"),
    complete: true,
    artifactKind: "patch",
    summary: "Correct the answer.",
    patch: { format: "unified-diff", sha256: sha256(patch), content: patch },
    preimages: [{ path: "src/answer.js", sha256: sha256(before) }],
    claims: { testsRun: [] },
  };

  assert.equal(parseResultEnvelope(JSON.stringify(envelope)).runId, "run-1");
  const first = await boundImport({
    envelope,
    scratch,
    quarantineDir,
    allowedPaths: ["src/answer.js"],
    scanner: "skip",
    testMode: true,
    sourceRoot,
  });
  assert.equal(first.idempotent, false);
  assert.equal(first.path, "src/answer.js");
  assert.equal(first.outputSha256, sha256(after));
  assert.equal(await readFile(path.join(scratch, "src/answer.js"), "utf8"), after);

  const second = await boundImport({
    envelope,
    scratch,
    quarantineDir,
    allowedPaths: ["src/answer.js"],
    scanner: "skip",
    testMode: true,
    sourceRoot,
  });
  assert.equal(second.idempotent, true);
});

test("importResult rejects traversal, stale preimages, and out-of-scope paths", async (t) => {
  const scratch = await tempDir();
  const quarantineDir = path.join(await tempDir(), "quarantine");
  await writeFixture(scratch, "src/answer.js", "old\n");

  function envelopeFor(filePath, preimage = sha256("old\n")) {
    const patch = [
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    return {
      kind: "COLLAB_RESULT_V1",
      protocolVersion: 1,
      runId: "run-1",
      turnId: "turn-1",
      contextSha256: sha256("context"),
      complete: true,
      artifactKind: "patch",
      summary: "patch",
      patch: { format: "unified-diff", sha256: sha256(patch), content: patch },
      preimages: [{ path: filePath, sha256: preimage }],
      claims: { testsRun: [] },
    };
  }

  const cases = [
    ["traversal", envelopeFor("../../escape"), ["../../escape"], "PATH_TRAVERSAL"],
    ["stale", envelopeFor("src/answer.js", sha256("different\n")), ["src/answer.js"], "PREIMAGE_STALE"],
    ["scope", envelopeFor("src/answer.js"), ["src/other.js"], "PATCH_OUT_OF_SCOPE"],
  ];
  for (const [name, envelope, allowedPaths, code] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        boundImport({
          envelope,
          scratch,
          quarantineDir,
          allowedPaths,
          scanner: "skip",
          testMode: true,
        }),
        (error) => error.code === code,
      );
    });
  }
});

test("importResult quarantines and scans the exact result before source mutation", async () => {
  const scratch = await tempDir();
  const quarantineDir = path.join(await tempDir(), "quarantine");
  const before = "old\n";
  await writeFixture(scratch, "source.txt", before);
  const patch = [
    "--- a/source.txt", "+++ b/source.txt", "@@ -1,1 +1,1 @@",
    "-old", "+new", "",
  ].join("\n");
  const envelope = {
    kind: "COLLAB_RESULT_V1",
    protocolVersion: 1,
    runId: "run-scan",
    turnId: "turn-1",
    contextSha256: sha256("context"),
    complete: true,
    artifactKind: "patch",
    summary: "scanner fixture",
    patch: { format: "unified-diff", sha256: sha256(patch), content: patch },
    preimages: [{ path: "source.txt", sha256: sha256(before) }],
    claims: { testsRun: [] },
  };
  const scanner = await writeFixture(
    await tempDir(),
    "fake-gitleaks",
    "#!/bin/sh\nif [ \"$1\" = \"version\" ]; then echo 'fake 1.0'; exit 0; fi\nexit 11\n",
  );
  await chmod(scanner, 0o700);

  await assert.rejects(
    boundImport({
      envelope,
      scratch,
      quarantineDir,
      allowedPaths: ["source.txt"],
      scanner,
      testMode: true,
    }),
    (error) => error.code === "SECRET_DETECTED",
  );
  assert.equal(await readFile(path.join(scratch, "source.txt"), "utf8"), before);
});

test("importResult recovers a crash after target replacement without duplicate application", async () => {
  const scratch = await tempDir();
  const sourceRoot = await tempDir();
  const quarantineDir = path.join(await tempDir(), "quarantine");
  const before = "before\n";
  const after = "after\n";
  await writeFixture(scratch, "source.txt", before);
  const patch = [
    "--- a/source.txt", "+++ b/source.txt", "@@ -1,1 +1,1 @@",
    "-before", "+after", "",
  ].join("\n");
  const envelope = {
    kind: "COLLAB_RESULT_V1",
    protocolVersion: 1,
    runId: "run-crash",
    turnId: "turn-1",
    contextSha256: sha256("context"),
    complete: true,
    artifactKind: "patch",
    summary: "crash recovery fixture",
    patch: { format: "unified-diff", sha256: sha256(patch), content: patch },
    preimages: [{ path: "source.txt", sha256: sha256(before) }],
    claims: { testsRun: [] },
  };

  await assert.rejects(
    boundImport({
      envelope,
      scratch,
      quarantineDir,
      allowedPaths: ["source.txt"],
      scanner: "skip",
      testMode: true,
      crashAfterTarget: true,
      sourceRoot,
    }),
    (error) => error.code === "SIMULATED_CRASH",
  );
  assert.equal(await readFile(path.join(scratch, "source.txt"), "utf8"), after);

  const recovered = await boundImport({
    envelope,
    scratch,
    quarantineDir,
    allowedPaths: ["source.txt"],
    scanner: "skip",
    testMode: true,
    sourceRoot,
  });
  assert.equal(recovered.idempotent, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.outputSha256, sha256(after));
});

test("importResult serializes competing applications for the same scratch target", async () => {
  const scratch = await tempDir();
  const sourceRoot = await tempDir();
  const quarantineDir = path.join(await tempDir(), "quarantine");
  const before = "before\n";
  await writeFixture(scratch, "source.txt", before);

  function competingEnvelope(runId, replacement) {
    const patch = [
      "--- a/source.txt", "+++ b/source.txt", "@@ -1,1 +1,1 @@",
      "-before", `+${replacement}`, "",
    ].join("\n");
    return {
      kind: "COLLAB_RESULT_V1",
      protocolVersion: 1,
      runId,
      turnId: "turn-1",
      contextSha256: sha256("context"),
      complete: true,
      artifactKind: "patch",
      summary: replacement,
      patch: { format: "unified-diff", sha256: sha256(patch), content: patch },
      preimages: [{ path: "source.txt", sha256: sha256(before) }],
      claims: { testsRun: [] },
    };
  }

  let releaseFirst;
  let firstPrepared;
  const firstPreparedPromise = new Promise((resolve) => {
    firstPrepared = resolve;
  });
  const releaseFirstPromise = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const firstEnvelope = competingEnvelope("run-first-writer", "first");
  const secondEnvelope = competingEnvelope("run-second-writer", "second");
  const first = boundImport({
    envelope: firstEnvelope,
    sourceRoot,
    scratch,
    quarantineDir,
    allowedPaths: ["source.txt"],
    scanner: "skip",
    testMode: true,
    testBeforeFinalCompare: async () => {
      firstPrepared();
      await releaseFirstPromise;
    },
  });
  await firstPreparedPromise;
  const second = boundImport({
    envelope: secondEnvelope,
    sourceRoot,
    scratch,
    quarantineDir,
    allowedPaths: ["source.txt"],
    scanner: "skip",
    testMode: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseFirst();

  const firstResult = await first;
  assert.equal(firstResult.outputSha256, sha256("first\n"));
  await assert.rejects(second, (error) => error.code === "PREIMAGE_STALE");
  assert.equal(await readFile(path.join(scratch, "source.txt"), "utf8"), "first\n");
});

test("importResult admits one winner across 32 competing processes", async () => {
  const scratch = await tempDir();
  const sourceRoot = await tempDir();
  const stateRoot = await tempDir();
  const targetLockDir = path.join(stateRoot, ".target-locks");
  const workerRoot = await tempDir();
  const before = "before\n";
  await writeFixture(scratch, "source.txt", before);
  const importModule = pathToFileURL(path.resolve(
    ".agents/skills/codex-chat/scripts/lib/import.mjs",
  )).href;
  const worker = await writeFixture(
    workerRoot,
    "import-worker.mjs",
    [
      `import { importResult } from ${JSON.stringify(importModule)};`,
      'import { readFile } from "node:fs/promises";',
      "const options = JSON.parse(await readFile(process.argv[2], 'utf8'));",
      "try {",
      "  const result = await importResult(options);",
      "  process.stdout.write(JSON.stringify({ ok: true, outputSha256: result.outputSha256 }));",
      "} catch (error) {",
      "  process.stdout.write(JSON.stringify({ ok: false, code: error.code }));",
      "}",
      "",
    ].join("\n"),
  );

  const workers = [];
  for (let index = 0; index < 32; index += 1) {
    const replacement = index % 2 === 0 ? "first" : "second";
    const patch = [
      "--- a/source.txt", "+++ b/source.txt", "@@ -1,1 +1,1 @@",
      "-before", `+${replacement}`, "",
    ].join("\n");
    const envelope = {
      kind: "COLLAB_RESULT_V1",
      protocolVersion: 1,
      runId: `run-process-${index}`,
      turnId: "turn-1",
      contextSha256: sha256("context"),
      complete: true,
      artifactKind: "patch",
      summary: replacement,
      patch: { format: "unified-diff", sha256: sha256(patch), content: patch },
      preimages: [{ path: "source.txt", sha256: sha256(before) }],
      claims: { testsRun: [] },
    };
    const quarantineDir = path.join(
      stateRoot,
      `run-process-${index}`,
      "quarantine",
    );
    const optionsPath = await writeFixture(
      workerRoot,
      `options-${index}.json`,
      `${JSON.stringify({
        envelope,
        scratch,
        sourceRoot,
        quarantineDir,
        targetLockDir,
        allowedPaths: ["source.txt"],
        expectedRunId: envelope.runId,
        expectedTurnId: envelope.turnId,
        expectedContextSha256: envelope.contextSha256,
        scanner: "skip",
        testMode: true,
      })}\n`,
    );
    workers.push(
      execFileAsync(process.execPath, [worker, optionsPath], {
        maxBuffer: 1024 * 1024,
      }).then(({ stdout }) => JSON.parse(stdout)),
    );
  }

  const outcomes = await Promise.all(workers);
  const winners = outcomes.filter(({ ok }) => ok);
  const losers = outcomes.filter(({ ok }) => !ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 31);
  assert.equal(
    losers.every(({ code }) => ["PREIMAGE_STALE", "TARGET_BUSY"].includes(code)),
    true,
  );
  const installed = await readFile(path.join(scratch, "source.txt"), "utf8");
  assert.equal(["first\n", "second\n"].includes(installed), true);
  let appliedReceiptCount = 0;
  for (let index = 0; index < 32; index += 1) {
    const names = await readdir(
      path.join(stateRoot, `run-process-${index}`, "quarantine"),
    );
    appliedReceiptCount += names.filter((name) =>
      name.endsWith(".imported.json")
    ).length;
  }
  assert.equal(appliedReceiptCount, 1);
});

test("importResult rejects a target changed after its prepared receipt", async () => {
  const scratch = await tempDir();
  const sourceRoot = await tempDir();
  const quarantineDir = path.join(await tempDir(), "quarantine");
  const before = "before\n";
  await writeFixture(scratch, "source.txt", before);
  const patch = [
    "--- a/source.txt", "+++ b/source.txt", "@@ -1,1 +1,1 @@",
    "-before", "+after", "",
  ].join("\n");
  const envelope = {
    kind: "COLLAB_RESULT_V1",
    protocolVersion: 1,
    runId: "run-final-compare",
    turnId: "turn-1",
    contextSha256: sha256("context"),
    complete: true,
    artifactKind: "patch",
    summary: "final compare fixture",
    patch: { format: "unified-diff", sha256: sha256(patch), content: patch },
    preimages: [{ path: "source.txt", sha256: sha256(before) }],
    claims: { testsRun: [] },
  };

  await assert.rejects(
    boundImport({
      envelope,
      sourceRoot,
      scratch,
      quarantineDir,
      allowedPaths: ["source.txt"],
      scanner: "skip",
      testMode: true,
      testBeforeFinalCompare: async () => {
        await writeFixture(scratch, "source.txt", "external change\n");
      },
    }),
    (error) => error.code === "PREIMAGE_CHANGED_DURING_IMPORT",
  );
  assert.equal(
    await readFile(path.join(scratch, "source.txt"), "utf8"),
    "external change\n",
  );
});

test("importResult rejects a symlinked scratch root", async () => {
  const realScratch = await tempDir();
  const parent = await tempDir();
  const scratch = path.join(parent, "linked-scratch");
  await symlink(realScratch, scratch);
  await writeFixture(realScratch, "source.txt", "old\n");
  const patch = [
    "--- a/source.txt", "+++ b/source.txt", "@@ -1,1 +1,1 @@",
    "-old", "+new", "",
  ].join("\n");
  const envelope = {
    kind: "COLLAB_RESULT_V1",
    protocolVersion: 1,
    runId: "run-link",
    turnId: "turn-1",
    contextSha256: sha256("context"),
    complete: true,
    artifactKind: "patch",
    summary: "link fixture",
    patch: { format: "unified-diff", sha256: sha256(patch), content: patch },
    preimages: [{ path: "source.txt", sha256: sha256("old\n") }],
    claims: { testsRun: [] },
  };

  await assert.rejects(
    boundImport({
      envelope,
      scratch,
      quarantineDir: path.join(await tempDir(), "quarantine"),
      allowedPaths: ["source.txt"],
      scanner: "skip",
      testMode: true,
    }),
    (error) => error.code === "SCRATCH_INVALID",
  );
});

test("importResult rejects a non-UTF-8 source preimage", async () => {
  const scratch = await tempDir();
  const binary = Buffer.from([0xff, 0xfe, 0x0a]);
  await writeFixture(scratch, "source.txt", binary);
  const patch = [
    "--- a/source.txt", "+++ b/source.txt", "@@ -1,1 +1,1 @@",
    "-old", "+new", "",
  ].join("\n");
  const envelope = {
    kind: "COLLAB_RESULT_V1",
    protocolVersion: 1,
    runId: "run-binary",
    turnId: "turn-1",
    contextSha256: sha256("context"),
    complete: true,
    artifactKind: "patch",
    summary: "binary fixture",
    patch: { format: "unified-diff", sha256: sha256(patch), content: patch },
    preimages: [{ path: "source.txt", sha256: sha256(binary) }],
    claims: { testsRun: [] },
  };

  await assert.rejects(
    boundImport({
      envelope,
      scratch,
      quarantineDir: path.join(await tempDir(), "quarantine"),
      allowedPaths: ["source.txt"],
      scanner: "skip",
      testMode: true,
    }),
    (error) => error.code === "SOURCE_FORMAT_UNSUPPORTED",
  );
});

test("importResult binds receipts to the producing turn and scratch identity", async () => {
  const sourceRoot = await tempDir();
  const firstScratch = await tempDir();
  const secondScratch = await tempDir();
  const quarantineDir = path.join(await tempDir(), "quarantine");
  const before = "old\n";
  for (const scratch of [firstScratch, secondScratch]) {
    await writeFixture(scratch, "source.txt", before);
  }
  const patch = [
    "--- a/source.txt", "+++ b/source.txt", "@@ -1,1 +1,1 @@",
    "-old", "+new", "",
  ].join("\n");
  const envelope = {
    kind: "COLLAB_RESULT_V1",
    protocolVersion: 1,
    runId: "run-bound",
    turnId: "turn-bound",
    contextSha256: sha256("context"),
    complete: true,
    artifactKind: "patch",
    summary: "binding fixture",
    patch: { format: "unified-diff", sha256: sha256(patch), content: patch },
    preimages: [{ path: "source.txt", sha256: sha256(before) }],
    claims: { testsRun: [] },
  };

  await assert.rejects(
    importResult({
      envelope,
      sourceRoot,
      scratch: firstScratch,
      quarantineDir,
      allowedPaths: ["source.txt"],
      expectedRunId: envelope.runId,
      expectedTurnId: "different-turn",
      expectedContextSha256: envelope.contextSha256,
      scanner: "skip",
      testMode: true,
    }),
    (error) => error.code === "RESULT_TURN_MISMATCH",
  );

  const first = await boundImport({
    envelope,
    sourceRoot,
    scratch: firstScratch,
    quarantineDir,
    allowedPaths: ["source.txt"],
    scanner: "skip",
    testMode: true,
  });
  const second = await boundImport({
    envelope,
    sourceRoot,
    scratch: secondScratch,
    quarantineDir,
    allowedPaths: ["source.txt"],
    scanner: "skip",
    testMode: true,
  });
  assert.notEqual(first.applicationKey, second.applicationKey);
});
