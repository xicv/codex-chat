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
import {
  LIMITS_DISTRIBUTED_V1,
  LIMITS_V1,
  LIMITS_V2,
} from "../../.agents/skills/codex-chat/scripts/lib/limits.mjs";
import {
  DISTRIBUTED_COORDINATION_OPERATIONS,
} from "../../.agents/skills/codex-chat/scripts/lib/distributed-coordination.mjs";

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

test("skill proves browser and provider readiness before preparing outbound source", async () => {
  const instructions = await readFile(
    path.resolve(".agents/skills/codex-chat/SKILL.md"),
    "utf8",
  );
  const transportGate = instructions.indexOf(
    "## Prove browser transport before source work",
  );
  const contextPreparation = instructions.indexOf(
    "## Prepare deterministic context",
  );
  assert.notEqual(transportGate, -1);
  assert.ok(transportGate < contextPreparation);
  const gate = instructions.slice(transportGate, contextPreparation);
  assert.match(
    gate,
    /Before selecting outbound files, packing, scanning, creating a run, or reserving a send/,
  );
  assert.match(gate, /nodeRepl\.write\("CODEX_CHAT_TRANSPORT_OK"\)/);
  assert.match(
    gate,
    /reacquire `node_repl\/js` through\s+tool discovery once/,
  );
  assert.match(gate, /Do not call `js_reset`/);
  assert.match(
    gate,
    /Do not\s+switch to another\s+`node_repl`-backed surface/,
  );
  assert.match(gate, /restart(?:ing)? the ChatGPT\s+desktop app/);
  assert.match(gate, /no capsule was prepared or transmitted/);
  assert.match(
    gate,
    /[Oo]pen or claim the intended external collaborator conversation/,
  );
  assert.match(
    gate,
    /verify that its authenticated composer\s+is ready/,
  );
  assert.match(
    gate,
    /Do not type,\s+paste, attach, upload, or send anything/,
  );
  assert.match(
    gate,
    /Only after the provider-readiness check passes may source selection/,
  );
  assert.match(
    gate,
    /If provider readiness fails[\s\S]*no capsule was prepared or transmitted/,
  );
});

test("normative JSON schemas are valid and expose the v1 required fields", async () => {
  const expectations = {
    "collab-context-v1.schema.json": ["kind", "protocolVersion", "rootLabel", "files"],
    "collab-result-v1.schema.json": [
      "kind", "protocolVersion", "runId", "turnId", "contextSha256",
      "complete", "artifactKind", "summary", "claims",
    ],
    "collab-context-manifest-v2.schema.json": [
      "kind", "protocolVersion", "rootLabel", "planSha256", "routing",
      "checkpointNamespace", "parent", "checkpoint", "representations",
    ],
    "manifest-plan-v2.schema.json": [
      "kind", "protocolVersion", "routing", "checkpointNamespace", "parent",
      "checkpoint", "representations",
    ],
    "delivery-receipt-plan-v2.schema.json": [
      "kind", "protocolVersion", "manifestSha256", "expectedEventSequence",
      "expectedEventHash", "routing", "runId", "contextSha256",
      "conversationIdentity", "turnId", "transport", "locator", "observedAt",
      "evidenceClass", "providerNamespace", "providerMessageId",
      "providerAttachmentId", "providerMessageFingerprint",
      "providerAttachmentFingerprint", "evidenceKind", "evidenceSha256",
      "evidenceBytes", "representation",
    ],
    "collab-delivery-receipt-v2.schema.json": [
      "kind", "protocolVersion", "slotId", "planSha256", "manifestSha256",
      "manifestPlanSha256", "runId", "expectedEventSequence",
      "expectedEventHash", "contextSha256", "routing", "conversationIdentity",
      "turnId", "transport", "locator", "observedAt", "evidenceClass",
      "provider", "evidence", "representation", "receiptId",
    ],
    "verify-plan-v1.schema.json": [
      "kind", "protocolVersion", "cwd", "sourceRoot", "scratchRoot",
      "argv", "timeoutMs", "evidenceClass",
    ],
    "terminal-capture-receipt-v1.schema.json": [
      "kind", "protocolVersion", "slotId", "bindings", "capture",
      "resultEnvelope", "receiptId",
    ],
    "transport-recovery-plan-v1.schema.json": [
      "kind", "protocolVersion", "runHead", "routing", "mode", "sendAllowed",
      "resendAllowed", "markerReconciliationRequired",
      "conclusiveMarkerAbsenceMayReturnToController", "observationsAllowed",
      "outbound", "conversationLeases", "allowedLedgerEvents",
      "forbiddenTransportActions", "nextAction",
    ],
    "distributed-coordination-request-v1.schema.json": [
      "operation", "data",
    ],
    "distributed-coordination-event-v1.schema.json": [
      "kind", "protocolVersion", "sequence", "atMs", "limitsDigest",
      "request", "assignments", "resultDigest", "previousHash", "hash",
    ],
  };
  for (const [name, required] of Object.entries(expectations)) {
    const schema = JSON.parse(await readFile(path.join(schemaDir, name), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.deepEqual(schema.required, required);
    assert.equal(schema.additionalProperties, false);
  }
  const responseSchema = JSON.parse(
    await readFile(
      path.join(
        schemaDir,
        "distributed-coordination-response-v1.schema.json",
      ),
      "utf8",
    ),
  );
  assert.equal(
    responseSchema.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assert.equal(responseSchema.oneOf.length, 2);
  assert.deepEqual(responseSchema.oneOf[0].required, ["schema", "ok", "data"]);
  assert.deepEqual(responseSchema.oneOf[1].required, ["schema", "ok", "error"]);
});

test("versioned implementation limits agree with normative schemas", async () => {
  const contextSchema = JSON.parse(
    await readFile(path.join(schemaDir, "collab-context-v1.schema.json"), "utf8"),
  );
  const verifySchema = JSON.parse(
    await readFile(path.join(schemaDir, "verify-plan-v1.schema.json"), "utf8"),
  );
  const deliveryPlanSchema = JSON.parse(
    await readFile(
      path.join(schemaDir, "delivery-receipt-plan-v2.schema.json"),
      "utf8",
    ),
  );
  const deliveryReceiptSchema = JSON.parse(
    await readFile(
      path.join(schemaDir, "collab-delivery-receipt-v2.schema.json"),
      "utf8",
    ),
  );
  const terminalCaptureSchema = JSON.parse(
    await readFile(
      path.join(schemaDir, "terminal-capture-receipt-v1.schema.json"),
      "utf8",
    ),
  );
  assert.equal(contextSchema.properties.files.maxItems, LIMITS_V1.pack.maxFiles);
  assert.equal(
    verifySchema.properties.timeoutMs.maximum,
    LIMITS_V1.verify.maxTimeoutMs,
  );
  assert.equal(verifySchema.properties.argv.maxItems, LIMITS_V1.verify.maxArgvItems);
  assert.equal(
    deliveryPlanSchema.$defs.representation.properties.attachmentOrdinal.maximum,
    LIMITS_V2.delivery.maxRepresentations - 1,
  );
  assert.equal(
    deliveryReceiptSchema.$defs.representation.properties.attachmentOrdinal.maximum,
    LIMITS_V2.delivery.maxRepresentations - 1,
  );
  assert.equal(deliveryPlanSchema.$defs.locator.type, "object");
  assert.equal(deliveryReceiptSchema.$defs.locator.type, "object");
  assert.equal(
    deliveryPlanSchema.properties.evidenceBytes.maximum,
    LIMITS_V2.delivery.maxEvidenceBytes,
  );
  assert.equal(
    deliveryPlanSchema.$defs.nullableProviderId.oneOf[1].maxLength,
    LIMITS_V2.delivery.maxProviderIdBytes,
  );
  assert.equal(
    terminalCaptureSchema.properties.capture.properties.bytes.maximum,
    LIMITS_V1.terminalCapture.maxCaptureBytes,
  );
  assert.equal(LIMITS_V1.ledger.maxEventsPerRun, 1024);
  assert.equal(LIMITS_V1.ledger.completionEventReserve, 32);
  assert.equal(LIMITS_V1.ledger.resourceObservationCoalesceMs, 5_000);
  const distributedRequestSchema = JSON.parse(
    await readFile(
      path.join(
        schemaDir,
        "distributed-coordination-request-v1.schema.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    distributedRequestSchema.properties.operation.enum,
    [...DISTRIBUTED_COORDINATION_OPERATIONS],
  );
  assert.equal(LIMITS_DISTRIBUTED_V1.mailbox.maxQueuedMessages, 128);
  assert.equal(LIMITS_DISTRIBUTED_V1.mailbox.maxQueuedBytes, 1024 * 1024);
  assert.equal(LIMITS_DISTRIBUTED_V1.mailbox.maxRetainedMessages, 512);
  assert.equal(LIMITS_DISTRIBUTED_V1.mailbox.maxPruneBatch, 128);
  assert.equal(LIMITS_DISTRIBUTED_V1.state.maxMessageTombstones, 16_384);
  assert.equal(
    LIMITS_DISTRIBUTED_V1.state.maxIdempotencyBytes,
    32 * 1024 * 1024,
  );
  assert.equal(
    LIMITS_DISTRIBUTED_V1.state.maxRetainedPayloadBytes,
    32 * 1024 * 1024,
  );
  assert.equal(
    LIMITS_DISTRIBUTED_V1.state.maxJournalBytes,
    64 * 1024 * 1024,
  );
  assert.equal(
    LIMITS_DISTRIBUTED_V1.state.maxSnapshotBytes,
    128 * 1024 * 1024,
  );
  assert.equal(LIMITS_DISTRIBUTED_V1.control.maxRequestBytes, 128 * 1024);
  assert.equal(LIMITS_DISTRIBUTED_V1.control.maxRateLimitKeys, 4096);
  const distributedEventSchema = JSON.parse(
    await readFile(
      path.join(
        schemaDir,
        "distributed-coordination-event-v1.schema.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    distributedEventSchema.properties.request.allOf[1]
      .not.properties.operation.enum,
    ["run.read", "mail.inspect", "mail.list"],
  );
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
    [
      "preflight",
      "pack",
      "manifest",
      "delivery-receipt",
      "terminal-capture",
      "control-serve",
      "control",
      "record",
      "status",
      "resume",
      "recovery-plan",
      "import",
      "verify",
    ],
  );

  const version = await runCli(["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.json.ok, true);
  assert.equal(version.json.command, "version");
  assert.match(version.json.data.version, /^\d+\.\d+\.\d+$/);
});

test("installed CLI creates a scanned typed context manifest", async () => {
  const root = await tempDir();
  const planRoot = await tempDir();
  const outputRoot = await tempDir();
  const source = "line one\r\nline two\r\n";
  await writeFixture(root, "notes.txt", source);
  const planPath = await writeFixture(
    planRoot,
    "manifest-plan.json",
    `${JSON.stringify({
      kind: "CODEX_CHAT_MANIFEST_PLAN_V2",
      protocolVersion: 2,
      routing: {
        workspaceId: "workspace-contract",
        coordinatorId: "coordinator-contract",
        workUnitId: "work-unit-contract",
        agentId: "agent-contract",
      },
      checkpointNamespace: "workspace-contract:work-unit-contract",
      parent: null,
      checkpoint: {
        goal: "Verify installed manifest command.",
        invariants: ["Model visibility begins unknown."],
        decisions: [],
        unresolved: [],
        verificationStatus: "unverified",
      },
      representations: [{
        representationId: "notes-source",
        path: "notes.txt",
        modality: "text",
        mediaType: "text/plain",
        role: "source",
        purpose: "Installed command contract.",
        fidelity: "exact",
        sourceRepresentationId: null,
        locator: null,
        transform: null,
        expectedSha256: sha256(source),
      }],
    })}\n`,
  );
  const result = await runCli([
    "manifest",
    "--root", root,
    "--plan", planPath,
    "--output", path.join(outputRoot, "manifest.json"),
  ]);

  assert.equal(result.code, 0, JSON.stringify(result.json));
  assert.equal(result.json.data.representationCount, 1);
  assert.equal(result.json.data.representations[0].modelVisible, "unknown");
  assert.equal(result.json.data.scanner.clean, true);
});

test("installed CLI creates an immutable delivery receipt without claiming model visibility", async () => {
  const manifestRoot = await tempDir();
  const planRoot = await tempDir();
  const stateDir = await tempDir();
  const sourceRoot = await tempDir();
  const runId = "delivery-contract";
  const contextSha256 = "b".repeat(64);
  const conversationIdentity = "chatgpt:conversation-contract";
  const turnId = "turn-contract";
  const routing = {
    workspaceId: "workspace-contract",
    coordinatorId: "coordinator-contract",
    workUnitId: "work-unit-contract",
    agentId: "agent-contract",
  };
  const manifest = {
    kind: "COLLAB_CONTEXT_MANIFEST_V2",
    protocolVersion: 2,
    rootLabel: "fixture",
    planSha256: "1".repeat(64),
    routing,
    checkpointNamespace: "workspace-contract:work-unit-contract",
    parent: null,
    checkpoint: {
      goal: "Verify the installed delivery-receipt command.",
      invariants: ["Transport acceptance is not model visibility."],
      decisions: [],
      unresolved: [],
      verificationStatus: "unverified",
    },
    representations: [{
      representationId: "notes-source",
      path: "notes.txt",
      modality: "text",
      mediaType: "text/plain",
      role: "source",
      purpose: "Installed delivery receipt contract.",
      bytes: 5,
      sha256: sha256("safe\n"),
      fidelity: "exact",
      sourceRepresentationId: null,
      sourceSha256: null,
      locator: null,
      transform: null,
      text: { charset: "utf-8", bom: false, lineEndings: "lf" },
      delivery: {
        status: "staged",
        modelVisible: "unknown",
        transport: null,
        conversationIdentity: null,
        turnId: null,
        providerAttachmentId: null,
        providerFingerprint: null,
      },
    }],
  };
  const manifestRaw = `${JSON.stringify(manifest)}\n`;
  const manifestPath = await writeFixture(
    manifestRoot,
    "manifest.json",
    manifestRaw,
  );
  await recordEvent({
    stateDir,
    runId,
    event: "prepared",
    data: {
      contextSha256,
      sourceRoot,
      routing: {
        workspaceId: routing.workspaceId,
        coordinatorId: routing.coordinatorId,
        workUnitId: routing.workUnitId,
      },
      requiredGates: ["contract"],
    },
    expectedSequence: 0,
    expectedState: null,
    idempotencyKey: "delivery-contract-prepared",
  });
  await recordEvent({
    stateDir,
    runId,
    event: "send_reserved",
    data: {
      turnId,
      marker: "DELIVERY_CONTRACT_MARKER",
      expectedTerminalMarker: "DELIVERY_CONTRACT_TERMINAL",
      payloadSha256: contextSha256,
      conversationIdentity,
      routing,
    },
    expectedSequence: 1,
    expectedState: "prepared",
    idempotencyKey: "delivery-contract-reserved",
  });
  await recordEvent({
    stateDir,
    runId,
    event: "send_confirmed",
    data: {
      turnId,
      marker: "DELIVERY_CONTRACT_MARKER",
      conversationIdentity,
      conversationUrl: "chatgpt://conversation-contract",
      routing,
      transportKind: "native-chat",
      observedAt: "2026-07-29T07:59:00.000Z",
      confirmationEvidenceClass: "host-accepted",
      providerMessageFingerprint: null,
      locator: {
        type: "thread-id",
        value: "conversation-contract",
      },
    },
    expectedSequence: 2,
    expectedState: "send_reserved",
    idempotencyKey: "delivery-contract-confirmed",
  });
  const run = await loadRun({ stateDir, runId });
  const evidence = "provider accepted attachment-contract\n";
  const evidencePath = await writeFixture(
    await tempDir(),
    "delivery-evidence.txt",
    evidence,
  );
  const planPath = await writeFixture(
    planRoot,
    "delivery-plan.json",
    `${JSON.stringify({
      kind: "CODEX_CHAT_DELIVERY_RECEIPT_PLAN_V2",
      protocolVersion: 2,
      manifestSha256: sha256(manifestRaw),
      expectedEventSequence: run.eventCount,
      expectedEventHash: run.lastEventHash,
      routing,
      runId,
      contextSha256,
      conversationIdentity,
      turnId,
      transport: "native-chat",
      locator: {
        type: "thread-id",
        value: "conversation-contract",
      },
      observedAt: "2026-07-29T08:00:00.000Z",
      evidenceClass: "host-attachment-accepted",
      providerNamespace: "chatgpt",
      providerMessageId: null,
      providerAttachmentId: null,
      providerMessageFingerprint: null,
      providerAttachmentFingerprint: sha256("attachment-contract"),
      evidenceKind: "provider-metadata",
      evidenceSha256: sha256(evidence),
      evidenceBytes: Buffer.byteLength(evidence),
      representation: {
        representationId: "notes-source",
        representationSha256: sha256("safe\n"),
        status: "accepted",
        attachmentOrdinal: 0,
        declaredBytes: 5,
        declaredDetail: "original",
      },
    })}\n`,
  );

  const result = await runCli([
    "delivery-receipt",
    "--state-dir", stateDir,
    "--run-id", runId,
    "--manifest", manifestPath,
    "--plan", planPath,
    "--evidence", evidencePath,
  ]);

  assert.equal(result.code, 0, JSON.stringify(result.json));
  assert.equal(result.json.data.representationCount, 1);
  assert.equal(result.json.data.representations[0].status, "accepted");
  assert.equal(result.json.data.representations[0].modelVisible, "unknown");
  assert.equal(result.json.data.scanner.clean, true);
  assert.equal(result.json.data.idempotent, false);
  assert.match(
    result.json.data.artifactPath,
    new RegExp(`${runId}/delivery-receipts/[a-f0-9]{64}\\.json$`),
  );
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

test("installed CLI isolates gitleaks policy from parent and payload injection", async () => {
  const root = await tempDir();
  const output = await tempDir();
  const customConfig = await writeFixture(
    await tempDir(),
    "injected-gitleaks.toml",
    [
      'title = "Injected configuration"',
      "[[rules]]",
      'id = "never-match"',
      'description = "Deliberately misses the fixture"',
      'regex = "CODEX_CHAT_NEVER_MATCH_THIS"',
      "",
    ].join("\n"),
  );
  const sidekiqFixture = [
    "export BUNDLE_ENTERPRISE__CONTRIBSYS__COM=",
    "cafe",
    "babe:",
    "dead",
    "beef",
  ].join("");
  await writeFixture(
    root,
    "leak.txt",
    `${sidekiqFixture}\n`,
  );
  await writeFixture(
    root,
    "inline-allow.txt",
    `${sidekiqFixture} # gitleaks:allow\n`,
  );

  const cases = [
    { GITLEAKS_CONFIG: customConfig },
    {
      GITLEAKS_CONFIG_TOML: [
        'title = "Injected configuration"',
        "[[rules]]",
        'id = "never-match"',
        'description = "Deliberately misses the fixture"',
        'regex = "CODEX_CHAT_NEVER_MATCH_THIS"',
        "",
      ].join("\n"),
    },
  ];
  for (const [index, env] of cases.entries()) {
    const result = await runCli([
      "pack",
      "--root", root,
      "--include", "leak.txt",
      "--output", path.join(output, `context-${index}.json`),
    ], { env });
    assert.equal(result.code, 2);
    assert.equal(result.json.error.code, "SECRET_DETECTED");
  }

  const inlineAllow = await runCli([
    "pack",
    "--root", root,
    "--include", "inline-allow.txt",
    "--output", path.join(output, "inline-allow-context.json"),
  ]);
  assert.equal(inlineAllow.code, 2);
  assert.equal(inlineAllow.json.error.code, "SECRET_DETECTED");

  await writeFixture(root, "safe.txt", "safe\n");
  const safe = await runCli([
    "pack",
    "--root", root,
    "--include", "safe.txt",
    "--output", path.join(output, "safe-context.json"),
  ], { env: cases[0] });
  assert.equal(safe.code, 0, safe.stderr);
  assert.equal(safe.json.data.scanner.configuration, "builtin-default");
  assert.equal(safe.json.data.scanner.environmentSanitized, true);
  assert.equal(safe.json.data.scanner.inlineAllowDisabled, true);
  assert.equal(safe.json.data.scanner.ignoreFileIsolated, true);
});

test("installed CLI forbids changing versioned packing limits", async () => {
  const root = await tempDir();
  const output = await tempDir();
  await writeFixture(root, "safe.txt", "safe\n");

  for (const option of ["--max-file-bytes", "--max-total-bytes"]) {
    const result = await runCli([
      "pack",
      "--root", root,
      "--include", "safe.txt",
      "--output", path.join(output, `${option.slice(2)}.json`),
      option, String(1024 * 1024),
    ]);
    assert.equal(result.code, 2);
    assert.equal(result.json.error.code, "LIMIT_OVERRIDE_FORBIDDEN");
  }
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
