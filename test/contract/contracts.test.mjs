import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  loadRun,
  recordEvent,
  statePaths,
} from "../../.agents/skills/codex-chat/scripts/lib/state.mjs";
import { runCli, tempDir, writeFixture } from "../helpers.mjs";
import { LIMITS_V1 } from "../../.agents/skills/codex-chat/scripts/lib/limits.mjs";

const schemaDir = path.resolve(
  ".agents/skills/codex-chat/references/schemas",
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("installed metadata mechanically disables implicit invocation", async () => {
  const metadata = await readFile(
    path.resolve(".agents/skills/codex-chat/agents/openai.yaml"),
    "utf8",
  );
  assert.match(metadata, /^policy:\n  allow_implicit_invocation: false\n?$/m);
});

test("normative JSON schemas are valid and expose the v1 required fields", async () => {
  const expectations = {
    "collab-context-v1.schema.json": ["kind", "protocolVersion", "rootLabel", "files"],
    "collab-result-v1.schema.json": [
      "kind", "protocolVersion", "runId", "turnId", "contextSha256",
      "complete", "artifactKind", "summary", "claims",
    ],
    "verify-plan-v1.schema.json": [
      "kind", "protocolVersion", "cwd", "sourceRoot", "scratchRoot",
      "argv", "timeoutMs", "evidenceClass",
    ],
  };
  for (const [name, required] of Object.entries(expectations)) {
    const schema = JSON.parse(await readFile(path.join(schemaDir, name), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.deepEqual(schema.required, required);
    assert.equal(schema.additionalProperties, false);
  }
});

test("versioned implementation limits agree with normative schemas", async () => {
  const contextSchema = JSON.parse(
    await readFile(path.join(schemaDir, "collab-context-v1.schema.json"), "utf8"),
  );
  const verifySchema = JSON.parse(
    await readFile(path.join(schemaDir, "verify-plan-v1.schema.json"), "utf8"),
  );
  assert.equal(contextSchema.properties.files.maxItems, LIMITS_V1.pack.maxFiles);
  assert.equal(
    verifySchema.properties.timeoutMs.maximum,
    LIMITS_V1.verify.maxTimeoutMs,
  );
  assert.equal(verifySchema.properties.argv.maxItems, LIMITS_V1.verify.maxArgvItems);
});

test("loadRun fails closed for unsupported state versions", async () => {
  const stateDir = await tempDir();
  const paths = statePaths(stateDir, "future-run");
  await mkdir(paths.directory, { recursive: true });
  await writeFile(paths.state, '{"schemaVersion":2,"eventCount":0}\n');

  await assert.rejects(
    loadRun({ stateDir, runId: "future-run" }),
    (error) => error.code === "STATE_VERSION_UNSUPPORTED",
  );
});

test("CLI errors use the stable JSON envelope and policy exit code", async () => {
  const root = await tempDir();
  await writeFixture(root, "safe.txt", "safe\n");
  const result = await runCli(
    [
      "preflight", "--root", root, "--include", "../escape",
      "--state-dir", path.join(root, ".state"),
    ],
  );
  assert.equal(result.code, 2);
  assert.equal(result.json.schema, "codex-chat/cli/v1");
  assert.equal(result.json.ok, false);
  assert.equal(result.json.protocolVersion, 1);
  assert.equal(result.json.error.code, "PATH_TRAVERSAL");
});

test("CLI exposes machine-readable help and version without repository context", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.equal(help.json.ok, true);
  assert.equal(help.json.command, "help");
  assert.match(help.json.data.usage, /\$codex-chat/);
  assert.deepEqual(
    help.json.data.commands,
    ["preflight", "pack", "record", "status", "resume", "import", "verify"],
  );

  const version = await runCli(["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.json.ok, true);
  assert.equal(version.json.command, "version");
  assert.match(version.json.data.version, /^\d+\.\d+\.\d+$/);
});

test("installed CLI rejects scanner overrides and ignores the old test bypass", async () => {
  const root = await tempDir();
  const stateDir = await tempDir();
  await writeFixture(root, "safe.txt", "safe\n");

  for (const scanner of ["/usr/bin/true", "skip", "gitleaks"]) {
    const result = await runCli([
      "preflight",
      "--root", root,
      "--include", "safe.txt",
      "--state-dir", stateDir,
      "--scanner", scanner,
    ]);
    assert.equal(result.code, 2);
    assert.equal(result.json.error.code, "SCANNER_OVERRIDE_FORBIDDEN");
  }

  const ordinary = await runCli([
    "preflight",
    "--root", root,
    "--include", "safe.txt",
    "--state-dir", stateDir,
  ], { env: { CODEX_CHAT_TEST_MODE: "1" } });
  assert.equal(ordinary.code, 0, ordinary.stderr);
  assert.equal(ordinary.json.data.scanner.mode, "gitleaks");
  assert.match(ordinary.json.data.scanner.executable, /gitleaks$/);
});

test("CLI import is unavailable before terminal response review", async () => {
  const stateDir = await tempDir();
  const scratch = await tempDir();
  await recordEvent({
    stateDir,
    runId: "early-import",
    event: "prepared",
    data: {
      contextSha256: "a".repeat(64),
      sourceRoot: scratch,
    },
    expectedSequence: 0,
    expectedState: null,
  });
  const result = await runCli([
    "import", "--state-dir", stateDir, "--run-id", "early-import",
    "--result", path.join(stateDir, "missing.json"),
    "--scratch", scratch, "--include", "source.txt",
  ]);
  assert.equal(result.code, 2);
  assert.equal(result.json.error.code, "IMPORT_STATE_INVALID");
});

test("CLI imports an advisory result without requiring a scratch directory", async () => {
  const stateDir = await tempDir();
  const sourceRoot = await tempDir();
  const runId = "advisory-cli";
  const contextSha256 = "a".repeat(64);
  const resultEnvelope = {
    kind: "COLLAB_RESULT_V1",
    protocolVersion: 1,
    runId,
    turnId: "advisory-turn",
    contextSha256,
    complete: true,
    artifactKind: "advisory",
    summary: "No source change is recommended.",
    claims: { findings: [] },
  };
  const resultRaw = `${JSON.stringify(resultEnvelope)}\n`;
  await recordEvent({
    stateDir,
    runId,
    event: "prepared",
    data: { contextSha256, sourceRoot },
    expectedSequence: 0,
    expectedState: null,
  });
  await recordEvent({
    stateDir,
    runId,
    event: "send_reserved",
    data: {
      turnId: "advisory-turn",
      marker: "ADVISORY_OUTBOUND_MARKER",
      expectedTerminalMarker: "ADVISORY_TERMINAL_MARKER",
      payloadSha256: contextSha256,
      conversationIdentity: "advisory-conversation",
    },
    expectedSequence: 1,
    expectedState: "prepared",
    idempotencyKey: "advisory-reserved",
  });
  await recordEvent({
    stateDir,
    runId,
    event: "send_confirmed",
    data: { turnId: "advisory-turn" },
    expectedSequence: 2,
    expectedState: "send_reserved",
    idempotencyKey: "advisory-confirmed",
  });
  await recordEvent({
    stateDir,
    runId,
    event: "response_terminal",
    data: {
      turnId: "advisory-turn",
      terminalMarker: "ADVISORY_TERMINAL_MARKER",
      responseSha256: "b".repeat(64),
      resultEnvelopeSha256: sha256(resultRaw),
      conversationIdentity: "advisory-conversation",
    },
    expectedSequence: 3,
    expectedState: "send_confirmed",
  });
  await recordEvent({
    stateDir,
    runId,
    event: "review_started",
    expectedSequence: 4,
    expectedState: "response_terminal",
  });
  const resultPath = path.join(await tempDir(), "advisory.json");
  await writeFile(resultPath, resultRaw);

  const differentPath = path.join(await tempDir(), "different-advisory.json");
  await writeFile(differentPath, `${JSON.stringify({
    ...resultEnvelope,
    summary: "A stale result with the same run bindings.",
  })}\n`);
  const different = await runCli([
    "import",
    "--state-dir", stateDir,
    "--run-id", runId,
    "--result", differentPath,
  ]);
  assert.equal(different.code, 2);
  assert.equal(different.json.error.code, "RESULT_RESPONSE_DIGEST_MISMATCH");

  const result = await runCli([
    "import",
    "--state-dir", stateDir,
    "--run-id", runId,
    "--result", resultPath,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.data.artifactKind, "advisory");
  assert.equal(result.json.data.idempotent, false);
});
