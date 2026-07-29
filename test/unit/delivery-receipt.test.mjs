import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, symlink } from "node:fs/promises";
import test from "node:test";
import {
  createDeliveryReceipt,
} from "../../.agents/skills/codex-chat/scripts/lib/delivery-receipt.mjs";
import {
  loadRun,
  recordEvent,
} from "../../.agents/skills/codex-chat/scripts/lib/state.mjs";
import { tempDir, writeFixture } from "../helpers.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function createConfirmedRun({
  stateDir,
  runId,
  contextSha256,
  routing,
  conversationIdentity,
  turnId,
}) {
  const sourceRoot = await tempDir();
  const runRouting = {
    workspaceId: routing.workspaceId,
    coordinatorId: routing.coordinatorId,
    workUnitId: routing.workUnitId,
  };
  await recordEvent({
    stateDir,
    runId,
    event: "prepared",
    data: {
      contextSha256,
      sourceRoot,
      routing: runRouting,
      requiredGates: ["delivery-gate"],
    },
    expectedSequence: 0,
    expectedState: null,
    idempotencyKey: "delivery-prepared",
  });
  await recordEvent({
    stateDir,
    runId,
    event: "send_reserved",
    data: {
      turnId,
      marker: "DELIVERY_VISIBLE_MARKER",
      expectedTerminalMarker: "DELIVERY_TERMINAL_MARKER",
      payloadSha256: contextSha256,
      conversationIdentity,
      routing,
    },
    expectedSequence: 1,
    expectedState: "prepared",
    idempotencyKey: "delivery-reserved",
  });
  await recordEvent({
    stateDir,
    runId,
    event: "send_confirmed",
    data: {
      turnId,
      marker: "DELIVERY_VISIBLE_MARKER",
      conversationIdentity,
      conversationUrl: "chatgpt://conversation-1",
      routing,
      transportKind: "native-chat",
      observedAt: "2026-07-29T07:44:00.000Z",
      confirmationEvidenceClass: "host-accepted",
      providerMessageFingerprint: null,
      locator: { type: "thread-id", value: "conversation-1" },
    },
    expectedSequence: 2,
    expectedState: "send_reserved",
    idempotencyKey: "delivery-confirmed",
  });
  return loadRun({ stateDir, runId });
}

async function deliveryFixture({
  evidenceContents = "provider accepted attachment-1\n",
  mutateManifest = () => {},
  mutatePlan = () => {},
} = {}) {
  const representationSha256 = sha256("exact representation bytes");
  const routing = {
    workspaceId: "workspace-1",
    coordinatorId: "coordinator-1",
    workUnitId: "work-unit-1",
    agentId: "agent-1",
  };
  const manifest = {
    kind: "COLLAB_CONTEXT_MANIFEST_V2",
    protocolVersion: 2,
    rootLabel: "fixture",
    planSha256: "1".repeat(64),
    routing: { ...routing },
    checkpointNamespace: "workspace-1:work-unit-1",
    parent: null,
    checkpoint: {
      goal: "Bind exact delivery evidence.",
      invariants: ["Provider acceptance is not model visibility."],
      decisions: [],
      unresolved: [],
      verificationStatus: "unverified",
    },
    representations: [{
      representationId: "source-1",
      path: "source.txt",
      modality: "text",
      mediaType: "text/plain",
      role: "source",
      purpose: "Delivery receipt fixture.",
      bytes: 26,
      sha256: representationSha256,
      fidelity: "exact",
      sourceRepresentationId: null,
      sourceSha256: null,
      locator: null,
      transform: null,
      text: { charset: "utf-8", bom: false, lineEndings: "none" },
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
  mutateManifest(manifest);
  const manifestRaw = `${JSON.stringify(manifest)}\n`;
  const manifestPath = await writeFixture(
    await tempDir(),
    "manifest.json",
    manifestRaw,
  );
  const evidenceBytes = Buffer.from(evidenceContents);
  const evidencePath = await writeFixture(
    await tempDir(),
    "evidence.txt",
    evidenceContents,
  );
  const stateDir = await tempDir();
  const runId = "delivery-run";
  const contextSha256 = "a".repeat(64);
  const conversationIdentity = "chatgpt:conversation-1";
  const turnId = "turn-1";
  const run = await createConfirmedRun({
    stateDir,
    runId,
    contextSha256,
    routing,
    conversationIdentity,
    turnId,
  });
  const plan = {
    kind: "CODEX_CHAT_DELIVERY_RECEIPT_PLAN_V2",
    protocolVersion: 2,
    manifestSha256: sha256(manifestRaw),
    expectedEventSequence: run.eventCount,
    expectedEventHash: run.lastEventHash,
    routing: { ...routing },
    runId,
    contextSha256,
    conversationIdentity,
    turnId,
    transport: "native-chat",
    locator: {
      type: "thread-id",
      value: "conversation-1",
    },
    observedAt: "2026-07-29T07:45:00.000Z",
    evidenceClass: "host-attachment-accepted",
    providerNamespace: "chatgpt",
    providerMessageId: null,
    providerAttachmentId: "attachment-1",
    providerMessageFingerprint: null,
    providerAttachmentFingerprint: null,
    evidenceKind: "provider-metadata",
    evidenceSha256: sha256(evidenceBytes),
    evidenceBytes: evidenceBytes.byteLength,
    representation: {
      representationId: "source-1",
      representationSha256,
      status: "accepted",
      attachmentOrdinal: 0,
      declaredBytes: 26,
      declaredDetail: "original",
    },
  };
  mutatePlan(plan);
  const planPath = await writeFixture(
    await tempDir(),
    "delivery-plan.json",
    `${JSON.stringify(plan)}\n`,
  );
  return {
    manifest,
    manifestRaw,
    manifestPath,
    plan,
    planPath,
    evidencePath,
    representationSha256,
    run,
    stateDir,
    runId,
    options: {
      stateDir,
      runId,
      manifestPath,
      planPath,
      evidencePath,
      scanner: "skip",
      testMode: true,
    },
  };
}

test("createDeliveryReceipt binds one confirmed transport observation without claiming model visibility", async () => {
  const fixture = await deliveryFixture();
  const manifestBefore = await readFile(fixture.manifestPath);

  const result = await createDeliveryReceipt(fixture.options);

  const receipt = JSON.parse(await readFile(result.artifactPath, "utf8"));
  assert.equal(receipt.kind, "COLLAB_DELIVERY_RECEIPT_V2");
  assert.equal(receipt.manifestSha256, sha256(fixture.manifestRaw));
  assert.equal(receipt.contextSha256, fixture.plan.contextSha256);
  assert.equal(receipt.runId, fixture.runId);
  assert.deepEqual(receipt.routing, fixture.manifest.routing);
  assert.equal(
    receipt.representation.representationSha256,
    fixture.representationSha256,
  );
  assert.equal(receipt.representation.modelVisible, "unknown");
  assert.equal(receipt.representation.deliveryStatus, "accepted");
  assert.equal(receipt.evidence.sha256, fixture.plan.evidenceSha256);
  assert.equal(result.sha256, sha256(`${JSON.stringify(receipt)}\n`));
  assert.equal(result.idempotent, false);
  assert.deepEqual(await readFile(fixture.manifestPath), manifestBefore);
  assert.equal((await loadRun(fixture)).eventCount, 3);
});

test("createDeliveryReceipt requires a durable coordinated run", async () => {
  const fixture = await deliveryFixture();

  await assert.rejects(
    createDeliveryReceipt({
      ...fixture.options,
      stateDir: await tempDir(),
      runId: "missing-run",
    }),
    (error) => error.code === "DELIVERY_RUN_STATE_INVALID",
  );
});

test("createDeliveryReceipt requires a bounded transport locator field", async () => {
  const fixture = await deliveryFixture({
    mutatePlan(plan) {
      delete plan.locator;
    },
  });

  await assert.rejects(
    createDeliveryReceipt(fixture.options),
    (error) => error.code === "DELIVERY_PLAN_INVALID",
  );
});

test("createDeliveryReceipt rejects non-RFC3339 observation times", async () => {
  const fixture = await deliveryFixture({
    mutatePlan(plan) {
      plan.observedAt = "0";
    },
  });

  await assert.rejects(
    createDeliveryReceipt(fixture.options),
    (error) => error.code === "DELIVERY_PLAN_INVALID",
  );
});

test("createDeliveryReceipt rejects terminal status without provider evidence", async () => {
  const fixture = await deliveryFixture({
    mutatePlan(plan) {
      plan.providerMessageId = null;
      plan.providerAttachmentId = null;
      plan.providerMessageFingerprint = null;
      plan.providerAttachmentFingerprint = null;
    },
  });

  await assert.rejects(
    createDeliveryReceipt(fixture.options),
    (error) => error.code === "DELIVERY_EVIDENCE_INSUFFICIENT",
  );
});

test("createDeliveryReceipt rejects malformed or historically rewritten manifests", async (t) => {
  const cases = [
    {
      name: "unexpected top-level field",
      mutateManifest(manifest) {
        manifest.untrustedExtension = true;
      },
    },
    {
      name: "missing required metadata",
      mutateManifest(manifest) {
        delete manifest.rootLabel;
      },
    },
    {
      name: "invented prior acceptance",
      mutateManifest(manifest) {
        manifest.representations[0].delivery.status = "accepted";
      },
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async () => {
      const fixture = await deliveryFixture(fixtureCase);
      await assert.rejects(
        createDeliveryReceipt(fixture.options),
        (error) => error.code === "DELIVERY_MANIFEST_INVALID",
      );
    });
  }
});

test("concurrent identical writers are idempotent and preserve one slot", async () => {
  const fixture = await deliveryFixture();

  const results = await Promise.all(
    Array.from(
      { length: 32 },
      () => createDeliveryReceipt(fixture.options),
    ),
  );

  assert.equal(results.filter(({ idempotent }) => !idempotent).length, 1);
  assert.equal(results.filter(({ idempotent }) => idempotent).length, 31);
  assert.equal(new Set(results.map(({ artifactPath }) => artifactPath)).size, 1);
  assert.equal(new Set(results.map(({ slotPath }) => slotPath)).size, 1);
});

test("a delivery slot cannot be rebound to divergent provider evidence", async () => {
  const fixture = await deliveryFixture();
  await createDeliveryReceipt(fixture.options);
  const divergentPlan = {
    ...fixture.plan,
    providerAttachmentId: "different-attachment",
  };
  const divergentPlanPath = await writeFixture(
    await tempDir(),
    "divergent-plan.json",
    `${JSON.stringify(divergentPlan)}\n`,
  );

  await assert.rejects(
    createDeliveryReceipt({
      ...fixture.options,
      planPath: divergentPlanPath,
    }),
    (error) => error.code === "DELIVERY_SLOT_CONFLICT",
  );
});

test("attachment ordinals are zero-based and bounded", async () => {
  const fixture = await deliveryFixture({
    mutatePlan(plan) {
      plan.representation.attachmentOrdinal = 64;
    },
  });

  await assert.rejects(
    createDeliveryReceipt(fixture.options),
    (error) => error.code === "DELIVERY_PLAN_INVALID",
  );
});

test("delivery evidence rejects symlinks without following them", async () => {
  const fixture = await deliveryFixture();
  const linkRoot = await tempDir();
  const evidenceLink = `${linkRoot}/evidence-link`;
  await symlink(fixture.evidencePath, evidenceLink);

  await assert.rejects(
    createDeliveryReceipt({
      ...fixture.options,
      evidencePath: evidenceLink,
    }),
    (error) => error.code === "DELIVERY_EVIDENCE_INVALID",
  );
});

test("the final run-head comparison rejects a race without publishing a slot", async () => {
  const fixture = await deliveryFixture();

  await assert.rejects(
    createDeliveryReceipt({
      ...fixture.options,
      testHooks: {
        async beforeCommit() {
          await recordEvent({
            stateDir: fixture.stateDir,
            runId: fixture.runId,
            event: "resource_observation",
            data: {
              resources: {
                transport: {
                  status: "available",
                  source: "delivery-race-test",
                  observedAt: "2026-07-29T07:46:00.000Z",
                },
              },
            },
            expectedSequence: fixture.run.eventCount,
            expectedState: fixture.run.phase,
            idempotencyKey: "delivery-race-head-change",
          });
        },
      },
    }),
    (error) => error.code === "DELIVERY_STREAM_HEAD_STALE",
  );

  const receiptDirectory = `${fixture.stateDir}/${fixture.runId}/delivery-receipts`;
  const published = await readdir(receiptDirectory);
  assert.deepEqual(published.filter((entry) => entry.endsWith(".json")), []);
});

test("receipt creation rejects stale and crossed identity bindings", async (t) => {
  const cases = [
    {
      name: "stale manifest bytes",
      code: "DELIVERY_MANIFEST_DIGEST_MISMATCH",
      mutatePlan(plan) {
        plan.manifestSha256 = "f".repeat(64);
      },
    },
    {
      name: "stale run stream head",
      code: "DELIVERY_STREAM_HEAD_STALE",
      mutatePlan(plan) {
        plan.expectedEventHash = "f".repeat(64);
      },
    },
    {
      name: "crossed coordinator route",
      code: "DELIVERY_ROUTE_MISMATCH",
      mutatePlan(plan) {
        plan.routing.coordinatorId = "different-coordinator";
      },
    },
    {
      name: "crossed conversation",
      code: "DELIVERY_CONVERSATION_MISMATCH",
      mutatePlan(plan) {
        plan.conversationIdentity = "chatgpt:different-conversation";
      },
    },
    {
      name: "crossed turn",
      code: "DELIVERY_TURN_MISMATCH",
      mutatePlan(plan) {
        plan.turnId = "different-turn";
      },
    },
    {
      name: "changed representation digest",
      code: "DELIVERY_REPRESENTATION_MISMATCH",
      mutatePlan(plan) {
        plan.representation.representationSha256 = "e".repeat(64);
      },
    },
    {
      name: "false exact-payload claim",
      code: "DELIVERY_EXACT_PAYLOAD_MISMATCH",
      mutatePlan(plan) {
        plan.evidenceKind = "exact-payload";
      },
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async () => {
      const fixture = await deliveryFixture({
        mutatePlan: fixtureCase.mutatePlan,
      });
      await assert.rejects(
        createDeliveryReceipt(fixture.options),
        (error) => error.code === fixtureCase.code,
      );
    });
  }
});
