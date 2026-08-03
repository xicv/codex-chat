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
  LIMITS_EGO_BOOTSTRAP_V1,
  LIMITS_CAPSULE_V1,
  LIMITS_DISTRIBUTED_V1,
  LIMITS_TRANSPORT_MANIFEST_V1,
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
  const defaultAttempt = gate.indexOf("### Default transport-attempt interface");
  const legacyGate = gate.indexOf("### Legacy low-level diagnostics");
  assert.notEqual(defaultAttempt, -1);
  assert.notEqual(legacyGate, -1);
  assert.ok(defaultAttempt < legacyGate);
  assert.match(gate, /transport-attempt \\\n+\s+--action start/);
  assert.match(gate, /--action status/);
  assert.match(gate, /collaboration-outcome \\\n+\s+--workspace-id/);
  assert.match(gate, /[Ii]nclude its returned `statement` verbatim/);
  assert.match(
    gate,
    /Never end, stop, hand off, or\s+switch to local-only execution while[\s\S]*`disposition=continue_required`[\s\S]*exact returned `decision`\s+and `nextAction`/,
  );
  assert.match(gate, /sourceEgress=not_authorized/);
  assert.match(
    gate,
    /Playwright[\s\S]*independent Codex evidence[\s\S]*not a transport fallback/,
  );
  assert.match(gate, /intentionally never returns either capability/);
  assert.match(gate, /reason: "primary_probe_in_progress"/);
  assert.match(gate, /does not include an\s+Ego task-space identity/);
  assert.match(gate, /Only this decision permits source\s+selection and capsule preparation/);
  assert.match(
    gate,
    /Before selecting outbound files, packing, scanning, creating a run, or\s+reserving a send/,
  );
  assert.match(gate, /transport-gate --action claim/);
  assert.match(gate, /If `probeAllowed` is false, do not call\s+`node_repl\/js`/);
  assert.match(gate, /same_host_cooldown_active/);
  assert.match(gate, /same_host_cooldown_elapsed/);
  assert.match(gate, /exact `reason` and `retryAfter`/);
  assert.match(gate, /one serialized\s+zero-I\/O half-open probe/);
  assert.match(gate, /probe_in_progress/);
  assert.match(gate, /built-in Browser is the primary transport/);
  assert.match(
    gate,
    /Ego\s+Browser is the only permitted alternative[\s\S]*conclusively unavailable/,
  );
  assert.match(gate, /read \[ego-browser\.md\]\(references\/ego-browser\.md\)/);
  assert.match(gate, /nodeRepl\.write\("CODEX_CHAT_TRANSPORT_OK"\)/);
  assert.match(
    gate,
    /reacquire\s+`node_repl\/js` through tool discovery once/,
  );
  assert.match(gate, /Do\s+not call `js_reset`/);
  assert.match(
    gate,
    /Do\s+not switch to\s+another `node_repl`-backed surface/,
  );
  assert.match(gate, /full restart of\s+the ChatGPT desktop app/);
  assert.match(
    gate,
    /transport-gate \\\n\s+--action failure \\\n\s+--claim-token <claim-token>/,
  );
  assert.match(gate, /browser-host\s+PIDs\/start times/);
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
  assert.match(
    gate,
    /Bind the selected transport for the complete run[\s\S]*do not switch/,
  );
  assert.match(
    gate,
    /If any action might have uploaded or submitted content[\s\S]*never\s+start the Ego fallback/,
  );
});

test("skill commits one atomic capsule generation before run creation", async () => {
  const instructions = await readFile(
    path.resolve(".agents/skills/codex-chat/SKILL.md"),
    "utf8",
  );
  const preparationStart = instructions.indexOf("## Prepare deterministic context");
  const runStart = instructions.indexOf("Create the run with the context artifact");
  assert.notEqual(preparationStart, -1);
  assert.notEqual(runStart, -1);
  assert.ok(preparationStart < runStart);
  const preparation = instructions.slice(preparationStart, runStart);
  assert.match(preparation, /prepare-capsule/);
  assert.match(preparation, /capsule-validate/);
  assert.match(preparation, /writes the create-once capsule receipt last/);
  assert.match(preparation, /Artifacts without that receipt\s+are incomplete/);
  assert.match(preparation, /Concurrent coordinators therefore converge/);
  assert.match(preparation, /different snapshot under the same\s+capsule ID fails closed/);
  assert.match(preparation, /do not use their separate outputs as a newly\s+prepared capsule/);
  assert.match(preparation, /opens no\s+missing store/);
  assert.match(preparation, /actionAuthorized` and `resendAuthorized` remain false/);
  assert.match(preparation, /shared trusted snapshot\s+boundary/);
});

test("a bounded external-response wait degrades independence without changing delivery state", async () => {
  const instructions = await readFile(
    path.resolve(".agents/skills/codex-chat/SKILL.md"),
    "utf8",
  );

  assert.match(instructions, /external-response observation budget/);
  assert.match(
    instructions,
    /record\s+`local_takeover`[\s\S]*response\s+remains pending and observe-only/,
  );
  assert.match(
    instructions,
    /Do not cancel the provider generation, click Stop, resend, switch transports,\s+close the bound task space, or record a terminal response/,
  );
  assert.match(
    instructions,
    /[Cc]ontinue local work[\s\S]*opportunistically observe the original\s+turn/,
  );
});

test("Ego fallback is one-shot, read-only, user-authenticated, and route-bound", async () => {
  const fallback = await readFile(
    path.resolve(
      ".agents/skills/codex-chat/references/ego-browser.md",
    ),
    "utf8",
  );

  assert.match(fallback, /Ego Browser is a pre-send fallback/);
  const leaseAcquire = fallback.indexOf("--action acquire");
  const firstEgoInvocation = fallback.indexOf("ego-browser nodejs <<'EOF'");
  assert.notEqual(leaseAcquire, -1);
  assert.notEqual(firstEgoInvocation, -1);
  assert.ok(leaseAcquire < firstEgoInvocation);
  assert.match(fallback, /If `acquired` is\s+false, stop before invoking Ego/);
  assert.match(fallback, /never persist its raw[\s\S]*pass `leaseToken` to Ego/);
  assert.match(
    fallback,
    /Hold the\s+bootstrap lease[\s\S]*has durably acquired the normal logical\s+conversation lease/,
  );
  assert.match(fallback, /--action release/);
  assert.match(
    fallback,
    /only after the\s+built-in Browser is conclusively unavailable/,
  );
  assert.match(fallback, /Do not use\s+`which ego-browser`/);
  assert.match(fallback, /ego-browser nodejs <<'EOF'/);
  assert.match(fallback, /crypto\.randomUUID\(\)/);
  assert.match(fallback, /useOrCreateTaskSpace/);
  assert.match(fallback, /openOrReuseTab\('https:\/\/chatgpt\.com\/'/);
  assert.match(fallback, /pageInfo\(\)/);
  assert.match(fallback, /snapshotText\(\)/);
  assert.match(fallback, /composerReady/);
  assert.match(fallback, /authenticated/);
  assert.match(fallback, /challengePresent/);
  assert.match(
    fallback,
    /Do not print the snapshot or conversation content/,
  );
  assert.match(fallback, /handOffTaskSpace\(taskSpaceId\)/);
  assert.match(
    fallback,
    /[Oo]nly after the user explicitly\s+confirms[\s\S]*takeOverTaskSpace\(taskSpaceId\)/,
  );
  assert.match(
    fallback,
    /If that one recheck fails,\s+stop/,
  );
  assert.match(
    fallback,
    /Never inspect cookies, profiles, passwords,[\s\S]*session storage/,
  );
  assert.match(fallback, /transportKind: "ego-browser"/);
  assert.match(
    fallback,
    /task-space ID\s+is transport evidence, not a provider conversation identity or locator/,
  );
  assert.match(
    fallback,
    /Reuse the same numeric\s+task-space ID for the complete run/,
  );
  assert.match(
    fallback,
    /If Ego fails after selection, stop[\s\S]*Do not return to the built-in Browser or try a third surface/,
  );
  assert.match(fallback, /completeTaskSpace\(taskSpaceId/);
  assert.match(fallback, /keep: plan\.keepTaskSpace/);
});

test("Ego diverts inherited drafts before egress and binds one dedicated tab", async () => {
  const fallback = await readFile(
    path.resolve(
      ".agents/skills/codex-chat/references/ego-browser.md",
    ),
    "utf8",
  );
  const fieldLabelStart = fallback.indexOf("const fieldLabel =");
  const controlsStart = fallback.indexOf("const controls =", fieldLabelStart);
  const cleanupStart = fallback.indexOf("## Finish the task space");
  const cleanupPlan = fallback.indexOf("planEgoCleanup({", cleanupStart);
  const closeBoundTarget = fallback.indexOf(
    "await closeTab(closeTargetId)",
    cleanupStart,
  );

  assert.notEqual(fieldLabelStart, -1);
  assert.notEqual(controlsStart, -1);
  assert.notEqual(cleanupStart, -1);
  assert.notEqual(cleanupPlan, -1);
  assert.notEqual(closeBoundTarget, -1);
  assert.doesNotMatch(
    fallback.slice(fieldLabelStart, controlsStart),
    /textContent/,
  );
  assert.ok(cleanupPlan < closeBoundTarget);

  assert.match(
    fallback,
    /classify the\s+composer draft before source selection, packing, scanning, run creation, or\s+send reservation/,
  );
  assert.match(
    fallback,
    /leave the inherited\s+draft and its original tab untouched/,
  );
  assert.match(fallback, /one source-free fresh-tab\s+attempt/);
  assert.match(
    fallback,
    /https:\/\/chatgpt\.com\/#codex-chat-\$\{preflightId\}/,
  );
  assert.match(
    fallback,
    /fresh\s+target ID differs from the inherited-draft target ID/,
  );
  assert.match(
    fallback,
    /[Bb]ind both `taskSpaceId`\s+and `targetId`[\s\S]*complete run/,
  );
  assert.match(
    fallback,
    /reselect the bound target[\s\S]*compose, submit, and observe/,
  );
  assert.match(fallback, /Never ask\s+the user to submit an unknown draft/);
  assert.match(
    fallback,
    /Never use unknown draft text to identify the composer, login, account, or\s+challenge state/,
  );
  assert.match(fallback, /const login = controls\.some/);
  assert.match(fallback, /const profile = controls\.some/);
  assert.match(
    fallback,
    /close only the bound\s+collaborator tab[\s\S]*plan\.keepTaskSpace/,
  );
  assert.match(fallback, /plan\.closeTargetIds/);
});

test("Ego executes the local readiness and cleanup decision core", async () => {
  const fallback = await readFile(
    path.resolve(
      ".agents/skills/codex-chat/references/ego-browser.md",
    ),
    "utf8",
  );
  const readinessStart = fallback.indexOf("## One read-only readiness attempt");
  const authenticationStart = fallback.indexOf("## User-owned authentication");
  const cleanupStart = fallback.indexOf("## Finish the task space");
  const decideCall = fallback.indexOf("decideEgoReadiness({", readinessStart);
  const cleanupCall = fallback.indexOf("planEgoCleanup({", cleanupStart);
  const closeCall = fallback.indexOf("await closeTab(", cleanupStart);
  const completeCall = fallback.indexOf(
    "await completeTaskSpace(",
    cleanupStart,
  );

  assert.notEqual(readinessStart, -1);
  assert.notEqual(authenticationStart, -1);
  assert.notEqual(cleanupStart, -1);
  assert.notEqual(decideCall, -1);
  assert.notEqual(cleanupCall, -1);
  assert.notEqual(closeCall, -1);
  assert.notEqual(completeCall, -1);
  assert.doesNotMatch(fallback, /process\.env\.CODEX_CHAT_SKILL_DIR/);
  assert.match(fallback, /const skillDir = "<skill>"/);
  assert.match(
    fallback,
    /Ego's isolated Node runtime does not inherit the invoking shell's\s+custom environment variables/,
  );
  assert.match(fallback, /ego-readiness\.mjs/);
  assert.ok(cleanupCall < closeCall);
  assert.ok(cleanupCall < completeCall);
  assert.doesNotMatch(
    fallback.slice(readinessStart, authenticationStart),
    /const ready = !failureReason/,
  );
});

test("Ego submission classifies stale drafts and preserves at-most-once reconciliation", async () => {
  const fallback = await readFile(
    path.resolve(
      ".agents/skills/codex-chat/references/ego-browser.md",
    ),
    "utf8",
  );
  const submitStart = fallback.indexOf("## Submit one bound turn");
  const cleanupStart = fallback.indexOf("## Finish the task space");
  assert.notEqual(submitStart, -1);
  assert.ok(submitStart < cleanupStart);
  const submit = fallback.slice(submitStart, cleanupStart);
  const decisionImport = submit.indexOf("ego-submission.mjs");
  const composeDecision = submit.indexOf("decideEgoCompose({");
  const preSubmitDecision = submit.indexOf("decideEgoPreSubmit({");
  const click = submit.indexOf("await click(");
  const postSubmitDecision = submit.indexOf("classifyEgoPostSubmit({");

  assert.notEqual(decisionImport, -1);
  assert.notEqual(composeDecision, -1);
  assert.notEqual(preSubmitDecision, -1);
  assert.notEqual(click, -1);
  assert.notEqual(postSubmitDecision, -1);
  assert.ok(decisionImport < composeDecision);
  assert.ok(composeDecision < preSubmitDecision);
  assert.ok(preSubmitDecision < click);
  assert.ok(click < postSubmitDecision);

  assert.match(submit, /durable `send_reserved` marker/);
  assert.match(
    submit,
    /Do not generate the marker inside a\s+browser heredoc/,
  );
  assert.match(submit, /Never use `fillInput` for ChatGPT's `contenteditable`/);
  assert.match(submit, /classify any stale draft/);
  assert.match(submit, /Never clear or overwrite an unknown\s+draft/);
  assert.match(
    submit,
    /exactly equals the expected planned\s+envelope[\s\S]*reuse\s+it without typing/,
  );
  assert.match(
    submit,
    /decision is `type_planned` with `safeToType: true`[\s\S]*call `typeText\(taskEnvelope\)`/,
  );
  assert.match(submit, /typeText\(taskEnvelope\)/);
  assert.match(
    submit,
    /composer text exactly\s+equals the manifest's composer text and digest/,
  );
  assert.match(submit, /exactly one\s+enabled send control/);
  assert.match(submit, /click\(submitDecision\.sendLocator/);
  assert.match(submit, /Do not use Enter or `pressKey` to submit/);
  assert.match(
    submit,
    /separate bounded heredocs for optional attachment upload, compose, submit,\s+and observe/,
  );
  assert.match(submit, /expectedTransportManifestSha256/);
  assert.match(submit, /transportManifest\.composer\.text/);
  assert.match(submit, /call `uploadFile` exactly\s+once/);
  assert.match(
    submit,
    /attachment ordinal, byte count, and digest/,
  );
  assert.match(
    submit,
    /If upload output is missing[\s\S]*stop without another upload or send/,
  );
  assert.match(
    submit,
    /exactly one user turn contains the durable marker/,
  );
  assert.match(submit, /missing\s+terminal\s+output/);
  assert.match(submit, /read-only marker reconciliation/);
  assert.match(submit, /never resend/);
  assert.match(
    submit,
    /`\/c\/WEB:`[\s\S]*provisional[\s\S]*stable canonical conversation locator/,
  );
  assert.match(submit, /Never pass composer, draft, response,[\s\S]*snapshot text/);
  assert.match(submit, /`actionAuthorized: false`/);
  assert.match(submit, /`resendAuthorized: false`/);
});

test("Ego canonicalizes multiline ProseMirror drafts without innerText paragraph inflation", async () => {
  const fallback = await readFile(
    path.resolve(
      ".agents/skills/codex-chat/references/ego-browser.md",
    ),
    "utf8",
  );
  const submitStart = fallback.indexOf("## Submit one bound turn");
  const cleanupStart = fallback.indexOf("## Finish the task space");
  assert.notEqual(submitStart, -1);
  assert.ok(submitStart < cleanupStart);
  const submit = fallback.slice(submitStart, cleanupStart);

  assert.match(submit, /Do not use\s+`innerText`/);
  assert.match(submit, /direct children are all `<p>` elements/);
  assert.match(submit, /child\.textContent \?\? ""/);
  assert.match(submit, /\.join\("\\n"\)/);
  assert.match(submit, /preserves empty paragraph elements/);
  assert.match(submit, /await import\("node:fs\/promises"\)/);
  assert.match(
    submit,
    /Do not use CommonJS `require`[\s\S]*top-level `await`/,
  );
  assert.match(
    submit,
    /unsupported composer DOM[\s\S]*stop without clearing, typing, or\s+sending/,
  );
});

test("normative JSON schemas are valid and expose the v1 required fields", async () => {
  const expectations = {
    "collab-context-v1.schema.json": ["kind", "protocolVersion", "rootLabel", "files"],
    "transport-manifest-v1.schema.json": [
      "kind", "protocolVersion", "transportKind", "uploadCapability",
      "strategy", "failureReason", "reservationEligible", "context",
      "taskEnvelope", "composer", "attachment", "thresholds",
      "modelVisible", "actionAuthorized", "resendAuthorized",
    ],
    "capsule-v1.schema.json": [
      "kind", "protocolVersion", "capsuleId", "context", "taskEnvelope",
      "transportManifest", "modelVisible", "actionAuthorized",
      "resendAuthorized",
    ],
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
  const transportManifestSchema = JSON.parse(
    await readFile(
      path.join(schemaDir, "transport-manifest-v1.schema.json"),
      "utf8",
    ),
  );
  const capsuleSchema = JSON.parse(
    await readFile(path.join(schemaDir, "capsule-v1.schema.json"), "utf8"),
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
    transportManifestSchema.properties.context.properties.bytes.maximum,
    LIMITS_TRANSPORT_MANIFEST_V1.maxContextBytes,
  );
  assert.equal(
    capsuleSchema.properties.context.properties.bytes.maximum,
    LIMITS_TRANSPORT_MANIFEST_V1.maxContextBytes,
  );
  assert.equal(
    LIMITS_CAPSULE_V1.maxReceiptBytes,
    32 * 1024,
  );
  assert.equal(
    transportManifestSchema.properties.taskEnvelope.properties.bytes.maximum,
    LIMITS_TRANSPORT_MANIFEST_V1.maxTaskEnvelopeInputBytes,
  );
  assert.equal(
    transportManifestSchema.properties.composer.properties.bytes.maximum,
    LIMITS_TRANSPORT_MANIFEST_V1.maxInlineComposerBytes,
  );
  assert.equal(
    transportManifestSchema.properties.thresholds.properties
      .maxTaskEnvelopeComposerBytes.const,
    LIMITS_TRANSPORT_MANIFEST_V1.maxTaskEnvelopeComposerBytes,
  );
  assert.equal(
    transportManifestSchema.properties.thresholds.properties
      .maxInlineContextBytes.const,
    LIMITS_TRANSPORT_MANIFEST_V1.maxInlineContextBytes,
  );
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
  assert.deepEqual(LIMITS_EGO_BOOTSTRAP_V1.lease, {
    minTtlMs: 60_000,
    defaultTtlMs: 900_000,
    maxTtlMs: 3_600_000,
  });
  const limitsReference = await readFile(
    path.resolve(".agents/skills/codex-chat/references/limits.md"),
    "utf8",
  );
  assert.match(limitsReference, /Minimum lease TTL \| 60,000 ms/);
  assert.match(limitsReference, /Default lease TTL \| 900,000 ms/);
  assert.match(limitsReference, /Maximum lease TTL \| 3,600,000 ms/);
  assert.match(
    limitsReference,
    /Serialized atomic capsule receipt \| 32,768 bytes/,
  );
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
    ["run.read", "mail.peek", "mail.inspect", "mail.list"],
  );
  assert.deepEqual(
    terminalCaptureSchema.properties.resultValidation.required,
    ["status", "errorCode"],
  );
  assert.equal(
    terminalCaptureSchema.properties.resultValidation.properties.status.const,
    "rejected",
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

test("CLI rejects an option not declared by the selected command", async () => {
  const result = await runCli([
    "status",
    "--run-id", "missing-run",
    "--state-dri", "/tmp/typo-must-not-be-ignored",
  ]);

  assert.equal(result.code, 2);
  assert.equal(result.json.error.code, "USAGE");
  assert.match(result.json.error.message, /Unknown option --state-dri/);
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
      "transport-attempt",
      "collaboration-outcome",
      "transport-gate",
      "ego-bootstrap-lease",
      "pack",
      "prepare-capsule",
      "capsule-validate",
      "transport-plan",
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
  assert.equal(
    help.json.data.commandContracts.length,
    help.json.data.commands.length,
  );
  assert.deepEqual(
    help.json.data.commandContracts.find(({ name }) => name === "status"),
    {
      name: "status",
      required: ["run-id"],
      optional: ["state-dir"],
      repeatable: [],
    },
  );
  assert.deepEqual(
    help.json.data.commandContracts.find(({ name }) => name === "pack"),
    {
      name: "pack",
      required: ["root", "output"],
      optional: [
        "state-dir", "include", "max-file-bytes", "max-total-bytes",
      ],
      repeatable: ["include"],
    },
  );

  const version = await runCli(["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.json.ok, true);
  assert.equal(version.json.command, "version");
  assert.match(version.json.data.version, /^\d+\.\d+\.\d+$/);
});

test("installed CLI creates a digest-bound size-aware transport manifest", async () => {
  const root = await tempDir();
  const artifacts = await tempDir();
  const source = "export const answer = 42;\n";
  const context = `${JSON.stringify({
    kind: "COLLAB_CONTEXT_V1",
    protocolVersion: 1,
    rootLabel: "contract",
    files: [{
      path: "src/answer.mjs",
      bytes: Buffer.byteLength(source),
      sha256: sha256(source),
      content: source,
    }],
  })}\n`;
  const taskEnvelope = "Review this exact bounded context.\n";
  const contextPath = await writeFixture(artifacts, "context.json", context);
  const taskEnvelopePath = await writeFixture(
    artifacts,
    "task-envelope.txt",
    taskEnvelope,
  );
  const output = path.join(artifacts, "transport-manifest.json");

  const result = await runCli([
    "transport-plan",
    "--root", root,
    "--context", contextPath,
    "--context-sha256", sha256(context),
    "--task-envelope", taskEnvelopePath,
    "--task-envelope-sha256", sha256(taskEnvelope),
    "--transport-kind", "ego-browser",
    "--upload-capability", "unknown",
    "--output", output,
  ]);

  assert.equal(result.code, 0, JSON.stringify(result.json));
  assert.equal(result.json.command, "transport-plan");
  assert.equal(result.json.data.strategy, "inline-context");
  assert.equal(result.json.data.reservationEligible, true);
  assert.equal(result.json.data.actionAuthorized, false);
  assert.equal(result.json.data.resendAuthorized, false);
  assert.equal(result.json.data.modelVisible, "unknown");
  assert.equal(result.json.data.scanner.clean, true);
  assert.equal(
    result.json.data.sha256,
    sha256(await readFile(result.json.data.artifactPath)),
  );
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
