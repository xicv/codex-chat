import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runCli, tempDir, writeFixture } from "../helpers.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("local CLI E2E completes an at-most-once external collaboration flow", async () => {
  const root = await tempDir("codex-chat-e2e-root-");
  const scratch = await tempDir("codex-chat-e2e-scratch-");
  const stateDir = await tempDir("codex-chat-e2e-state-");
  const runId = "e2e-run";
  const routing = {
    workspaceId: "workspace-e2e",
    coordinatorId: "coordinator-e2e",
    workUnitId: "work-unit-e2e",
  };
  const outboundRouting = { ...routing, agentId: "agent-e2e" };
  const before = "export const answer = 41;\n";
  const after = "export const answer = 42;\n";
  await writeFixture(root, "src/answer.mjs", before);
  await writeFixture(scratch, "src/answer.mjs", before);
  await writeFixture(
    scratch,
    "test.mjs",
    "const { answer } = await import('./src/answer.mjs'); if (answer !== 42) process.exit(1);\n",
  );
  const artifactPath = path.join(await tempDir(), "context.json");

  const packed = await runCli([
    "pack", "--root", root, "--state-dir", stateDir,
    "--include", "src/answer.mjs", "--output", artifactPath,
  ]);
  assert.equal(packed.code, 0, packed.stderr);
  const contextSha256 = packed.json.data.sha256;
  const taskEnvelopeSha256 = sha256("synthetic outbound task\n");

  async function record(event, sequence, expectedState, data = {}) {
    const dataPath = path.join(stateDir, `${sequence}-${event}.json`);
    await writeFile(dataPath, `${JSON.stringify(data)}\n`);
    const result = await runCli([
      "record", "--state-dir", stateDir, "--run-id", runId,
      "--event", event, "--expected-sequence", String(sequence),
      "--expected-state", expectedState ?? "null", "--data", dataPath,
      "--idempotency-key", `${sequence}-${event}`,
    ]);
    assert.equal(result.code, 0, JSON.stringify(result.json));
    return result.json.data.state;
  }

  await record("prepared", 0, null, {
    contextSha256,
    taskEnvelopeSha256,
    outboundBindingVersion: 2,
    sourceRoot: root,
    routing,
    requiredGates: ["synthetic-e2e"],
  });
  await record("send_reserved", 1, "prepared", {
    turnId: "turn-1",
    marker: "VISIBLE_E2E_MARKER",
    expectedTerminalMarker: "CODEX_CHAT_RESULT_COMPLETE",
    payloadSha256: contextSha256,
    contextSha256,
    taskEnvelopeSha256,
    outboundBindingVersion: 2,
    providerNamespace: "chatgpt",
    conversationIdentity: "synthetic-conversation",
    routing: outboundRouting,
  });
  await record("send_confirmed", 2, "send_reserved", {
    turnId: "turn-1",
    marker: "VISIBLE_E2E_MARKER",
    conversationIdentity: "synthetic-conversation",
    conversationUrl: "https://chatgpt.com/c/synthetic",
    routing: outboundRouting,
    providerNamespace: "chatgpt",
    transportKind: "synthetic-transport",
    observedAt: "2026-07-29T00:00:00.000Z",
    confirmationEvidenceClass: "synthetic-thread-observation",
    providerMessageFingerprint: sha256("synthetic-provider-message"),
    locator: { type: "thread-id", value: "synthetic-conversation" },
  });
  const disconnected = await record("transport_disconnected", 3, "send_confirmed", {
    error: "Transport closed",
  });
  assert.equal(disconnected.nextAction, "observe-and-reconcile-do-not-resend");
  const recovery = await runCli([
    "recovery-plan", "--state-dir", stateDir, "--run-id", runId,
  ]);
  assert.equal(recovery.code, 0, JSON.stringify(recovery.json));
  assert.equal(recovery.json.data.mode, "read-only");
  assert.equal(recovery.json.data.sendAllowed, false);
  assert.equal(recovery.json.data.resendAllowed, false);
  assert.equal(
    recovery.json.data.outbound.locator.value,
    "synthetic-conversation",
  );
  const patch = [
    "--- a/src/answer.mjs",
    "+++ b/src/answer.mjs",
    "@@ -1,1 +1,1 @@",
    "-export const answer = 41;",
    "+export const answer = 42;",
    "",
  ].join("\n");
  const resultEnvelope = {
    kind: "COLLAB_RESULT_V1",
    protocolVersion: 1,
    runId,
    turnId: "turn-1",
    contextSha256,
    complete: true,
    artifactKind: "patch",
    summary: "Correct the answer.",
    patch: { format: "unified-diff", sha256: sha256(patch), content: patch },
    preimages: [{ path: "src/answer.mjs", sha256: sha256(before) }],
    claims: { testsRun: [] },
  };
  const resultRaw = `${JSON.stringify(resultEnvelope)}\n`;
  const resultPath = path.join(stateDir, "result.json");
  await writeFile(resultPath, resultRaw);
  const capturePath = path.join(stateDir, "terminal-capture.txt");
  await writeFile(capturePath, [
    "Synthetic collaborator response.",
    "CODEX_CHAT_RESULT_BEGIN",
    JSON.stringify(resultEnvelope),
    "CODEX_CHAT_RESULT_END",
    "CODEX_CHAT_RESULT_COMPLETE",
    "",
  ].join("\n"));
  const captured = await runCli([
    "terminal-capture", "--state-dir", stateDir, "--run-id", runId,
    "--capture", capturePath, "--result", resultPath,
  ]);
  assert.equal(captured.code, 0, JSON.stringify(captured.json));
  await record(
    "response_terminal",
    4,
    "response_pending_unknown",
    captured.json.data.eventData,
  );
  await record("review_started", 5, "response_terminal");

  const imported = await runCli([
    "import", "--state-dir", stateDir, "--run-id", runId,
    "--result", resultPath, "--scratch", scratch, "--include", "src/answer.mjs",
  ]);
  assert.equal(imported.code, 0, imported.stderr);
  assert.equal(await readFile(path.join(scratch, "src/answer.mjs"), "utf8"), after);

  const traversalPatch = patch.replaceAll("src/answer.mjs", "../../escape");
  const traversalEnvelope = {
    ...resultEnvelope,
    patch: {
      format: "unified-diff",
      sha256: sha256(traversalPatch),
      content: traversalPatch,
    },
    preimages: [{ path: "../../escape", sha256: sha256(before) }],
  };
  const traversalPath = path.join(stateDir, "traversal.json");
  await writeFile(traversalPath, `${JSON.stringify(traversalEnvelope)}\n`);
  const traversal = await runCli([
    "import", "--state-dir", stateDir, "--run-id", runId,
    "--result", traversalPath, "--scratch", scratch, "--include", "../../escape",
  ]);
  assert.equal(traversal.code, 2);
  assert.equal(traversal.json.error.code, "RESULT_RESPONSE_DIGEST_MISMATCH");

  await record("validation_started", 6, "reviewing");
  const planPath = path.join(stateDir, "verify-plan.json");
  const planContents = `${JSON.stringify({
    kind: "CODEX_CHAT_VERIFY_V1",
    protocolVersion: 1,
    cwd: scratch,
    sourceRoot: root,
    scratchRoot: scratch,
    argv: [process.execPath, "test.mjs"],
    timeoutMs: 10_000,
    evidenceClass: "local-synthetic-e2e",
    bindings: {
      runId,
      turnId: "turn-1",
      contextSha256,
      ...outboundRouting,
      gateId: "synthetic-e2e",
      applicationKey: imported.json.data.applicationKey,
      postimageSha256: imported.json.data.outputSha256,
    },
  })}\n`;
  await writeFile(planPath, planContents);
  const planSha256 = sha256(planContents);
  const verified = await runCli([
    "verify", "--plan", planPath,
    "--plan-sha256", planSha256,
    "--evidence-dir", path.join(stateDir, runId, "evidence"),
  ]);
  assert.equal(verified.code, 0, verified.stderr);
  assert.equal(verified.json.data.exitCode, 0);

  const prematureAcceptance = await runCli([
    "record", "--state-dir", stateDir, "--run-id", runId,
    "--event", "accepted", "--expected-sequence", "7",
    "--expected-state", "validating",
    "--data-json", "{}",
    "--idempotency-key", "premature-acceptance",
  ]);
  assert.equal(prematureAcceptance.code, 2);
  assert.equal(prematureAcceptance.json.error.code, "VERIFICATION_REQUIRED");

  const receiptBytes = await readFile(verified.json.data.receiptPath);
  await record("verification_recorded", 7, "validating", {
    gateId: "synthetic-e2e",
    receiptPath: verified.json.data.receiptPath,
    receiptSha256: sha256(receiptBytes),
  });
  await writeFile(
    verified.json.data.receiptPath,
    Buffer.concat([receiptBytes, Buffer.from("tampered")]),
  );
  const changedReceiptAcceptance = await runCli([
    "record", "--state-dir", stateDir, "--run-id", runId,
    "--event", "accepted", "--expected-sequence", "8",
    "--expected-state", "validating",
    "--data-json", "{}",
    "--idempotency-key", "changed-receipt-acceptance",
  ]);
  assert.equal(changedReceiptAcceptance.code, 2);
  assert.equal(
    changedReceiptAcceptance.json.error.code,
    "VERIFICATION_RECEIPT_DIGEST_MISMATCH",
  );
  await writeFile(verified.json.data.receiptPath, receiptBytes);
  await record("accepted", 8, "validating");
  const status = await runCli([
    "status", "--state-dir", stateDir, "--run-id", runId,
  ]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.json.data.state.phase, "accepted");
  assert.equal(status.json.data.resendAllowed, false);
  assert.equal(status.json.data.nextAction, "complete");
  assert.equal(status.json.data.recoveryPlan.mode, "terminal");
  assert.equal(status.json.data.recoveryPlan.sendAllowed, false);
});
