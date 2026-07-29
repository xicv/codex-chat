import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runCli, tempDir, writeFixture } from "../helpers.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("local CLI E2E binds a derived representation receipt to one confirmed routed turn", async () => {
  const root = await tempDir("codex-chat-delivery-root-");
  const stateDir = await tempDir("codex-chat-delivery-state-");
  const artifacts = await tempDir("codex-chat-delivery-artifacts-");
  const runId = "delivery-e2e";
  const contextSha256 = sha256("portable context bytes");
  const taskEnvelopeSha256 = sha256("delivery e2e task envelope");
  const source = "Full engineering context.\n";
  const derived = "Engineering context excerpt.\n";
  await writeFixture(root, "source.txt", source);
  await writeFixture(root, "excerpt.txt", derived);
  const routing = {
    workspaceId: "workspace-delivery-e2e",
    coordinatorId: "coordinator-delivery-e2e",
    workUnitId: "work-unit-delivery-e2e",
    agentId: "agent-delivery-e2e",
  };
  const manifestPlanPath = await writeFixture(
    artifacts,
    "manifest-plan.json",
    `${JSON.stringify({
      kind: "CODEX_CHAT_MANIFEST_PLAN_V2",
      protocolVersion: 2,
      routing,
      checkpointNamespace: "workspace-delivery-e2e:work-unit-delivery-e2e",
      parent: null,
      checkpoint: {
        goal: "Bind a derived context representation to transport evidence.",
        invariants: ["Derived context never substitutes for exact source bytes."],
        decisions: [],
        unresolved: [],
        verificationStatus: "unverified",
      },
      representations: [
        {
          representationId: "source",
          path: "source.txt",
          modality: "text",
          mediaType: "text/plain",
          role: "source",
          purpose: "Exact source context.",
          fidelity: "exact",
          sourceRepresentationId: null,
          locator: null,
          transform: null,
          expectedSha256: sha256(source),
        },
        {
          representationId: "excerpt",
          path: "excerpt.txt",
          modality: "text",
          mediaType: "text/plain",
          role: "derived",
          purpose: "Bounded lossy excerpt.",
          fidelity: "lossy",
          sourceRepresentationId: "source",
          locator: null,
          transform: {
            tool: "fixture",
            version: "1",
            parameters: { selection: "summary" },
            coverage: "One synthetic excerpt.",
            truncated: true,
          },
          expectedSha256: sha256(derived),
        },
      ],
    })}\n`,
  );
  const manifestPath = path.join(artifacts, "manifest.json");
  const manifested = await runCli([
    "manifest",
    "--root", root,
    "--plan", manifestPlanPath,
    "--output", manifestPath,
  ]);
  assert.equal(manifested.code, 0, JSON.stringify(manifested.json));
  const manifestBefore = await readFile(manifestPath);

  async function record(event, sequence, expectedState, data) {
    const dataPath = path.join(artifacts, `${sequence}-${event}.json`);
    await writeFile(dataPath, `${JSON.stringify(data)}\n`);
    const result = await runCli([
      "record",
      "--state-dir", stateDir,
      "--run-id", runId,
      "--event", event,
      "--expected-sequence", String(sequence),
      "--expected-state", expectedState ?? "null",
      "--data", dataPath,
      "--idempotency-key", `delivery-e2e-${sequence}-${event}`,
    ]);
    assert.equal(result.code, 0, JSON.stringify(result.json));
    return result.json.data.state;
  }

  await record("prepared", 0, null, {
    contextSha256,
    taskEnvelopeSha256,
    outboundBindingVersion: 2,
    sourceRoot: root,
    routing: {
      workspaceId: routing.workspaceId,
      coordinatorId: routing.coordinatorId,
      workUnitId: routing.workUnitId,
    },
    requiredGates: ["delivery-e2e"],
  });
  await record("send_reserved", 1, "prepared", {
    turnId: "turn-delivery-e2e",
    marker: "DELIVERY_E2E_MARKER",
    expectedTerminalMarker: "DELIVERY_E2E_TERMINAL",
    payloadSha256: contextSha256,
    contextSha256,
    taskEnvelopeSha256,
    outboundBindingVersion: 2,
    providerNamespace: "chatgpt",
    conversationIdentity: "chatgpt:delivery-e2e",
    routing,
  });
  const providerMessageFingerprint = sha256("delivery-e2e-message");
  const confirmed = await record("send_confirmed", 2, "send_reserved", {
    turnId: "turn-delivery-e2e",
    marker: "DELIVERY_E2E_MARKER",
    conversationIdentity: "chatgpt:delivery-e2e",
    conversationUrl: "chatgpt://delivery-e2e",
    routing,
    providerNamespace: "chatgpt",
    transportKind: "native-chat",
    observedAt: "2026-07-29T08:10:00.000Z",
    confirmationEvidenceClass: "host-accepted",
    providerMessageFingerprint,
    locator: { type: "thread-id", value: "delivery-e2e" },
  });
  const evidence = "host accepted derived attachment at ordinal 1\n";
  const evidencePath = await writeFixture(
    artifacts,
    "delivery-evidence.txt",
    evidence,
  );
  const deliveryPlanPath = await writeFixture(
    artifacts,
    "delivery-plan.json",
    `${JSON.stringify({
      kind: "CODEX_CHAT_DELIVERY_RECEIPT_PLAN_V2",
      protocolVersion: 2,
      manifestSha256: sha256(manifestBefore),
      expectedEventSequence: confirmed.eventCount,
      expectedEventHash: confirmed.lastEventHash,
      routing,
      runId,
      contextSha256,
      conversationIdentity: "chatgpt:delivery-e2e",
      turnId: "turn-delivery-e2e",
      transport: "native-chat",
      locator: { type: "thread-id", value: "delivery-e2e" },
      observedAt: "2026-07-29T08:10:01.000Z",
      evidenceClass: "host-attachment-accepted",
      providerNamespace: "chatgpt",
      providerMessageId: null,
      providerAttachmentId: null,
      providerMessageFingerprint,
      providerAttachmentFingerprint: sha256("delivery-e2e-attachment"),
      evidenceKind: "provider-metadata",
      evidenceSha256: sha256(evidence),
      evidenceBytes: Buffer.byteLength(evidence),
      representation: {
        representationId: "excerpt",
        representationSha256: sha256(derived),
        status: "accepted",
        attachmentOrdinal: 1,
        declaredBytes: Buffer.byteLength(derived),
        declaredDetail: "low",
      },
    })}\n`,
  );
  const crossedProviderPlan = JSON.parse(
    await readFile(deliveryPlanPath, "utf8"),
  );
  crossedProviderPlan.providerNamespace = "different-provider";
  const crossedProviderPlanPath = await writeFixture(
    artifacts,
    "delivery-plan-crossed-provider.json",
    `${JSON.stringify(crossedProviderPlan)}\n`,
  );
  const crossedProvider = await runCli([
    "delivery-receipt",
    "--state-dir", stateDir,
    "--run-id", runId,
    "--manifest", manifestPath,
    "--plan", crossedProviderPlanPath,
    "--evidence", evidencePath,
  ]);
  assert.equal(crossedProvider.code, 2);
  assert.equal(
    crossedProvider.json.error.code,
    "DELIVERY_PROVIDER_MISMATCH",
  );

  const receipt = await runCli([
    "delivery-receipt",
    "--state-dir", stateDir,
    "--run-id", runId,
    "--manifest", manifestPath,
    "--plan", deliveryPlanPath,
    "--evidence", evidencePath,
  ]);
  assert.equal(receipt.code, 0, JSON.stringify(receipt.json));
  assert.equal(receipt.json.data.idempotent, false);
  const receiptArtifact = JSON.parse(
    await readFile(receipt.json.data.artifactPath, "utf8"),
  );
  assert.equal(receiptArtifact.representation.representationId, "excerpt");
  assert.equal(receiptArtifact.representation.fidelity, "lossy");
  assert.equal(receiptArtifact.representation.modelVisible, "unknown");
  assert.equal(receiptArtifact.expectedEventHash, confirmed.lastEventHash);
  assert.deepEqual(await readFile(manifestPath), manifestBefore);

  const replay = await runCli([
    "delivery-receipt",
    "--state-dir", stateDir,
    "--run-id", runId,
    "--manifest", manifestPath,
    "--plan", deliveryPlanPath,
    "--evidence", evidencePath,
  ]);
  assert.equal(replay.code, 0, JSON.stringify(replay.json));
  assert.equal(replay.json.data.idempotent, true);
  assert.equal(replay.json.data.artifactPath, receipt.json.data.artifactPath);
  const status = await runCli([
    "status",
    "--state-dir", stateDir,
    "--run-id", runId,
  ]);
  assert.equal(status.json.data.state.eventCount, 3);
  assert.equal(status.json.data.state.phase, "send_confirmed");
  assert.equal(status.json.data.resendAllowed, false);
});
