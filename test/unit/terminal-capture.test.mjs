import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createTerminalCaptureReceipt,
} from "../../.agents/skills/codex-chat/scripts/lib/terminal-capture.mjs";
import {
  loadRun,
  recordEvent,
} from "../../.agents/skills/codex-chat/scripts/lib/state.mjs";
import { tempDir, writeFixture } from "../helpers.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function createHardenedRun(
  stateDir,
  sourceRoot,
  { coordinated = true } = {},
) {
  const runId = "terminal-capture-run";
  const contextSha256 = "a".repeat(64);
  const taskEnvelopeSha256 = "b".repeat(64);
  const routing = coordinated
    ? {
        workspaceId: "workspace-capture",
        coordinatorId: "coordinator-capture",
        workUnitId: "work-unit-capture",
      }
    : null;
  const outboundRouting = coordinated
    ? { ...routing, agentId: "agent-capture" }
    : null;
  await recordEvent({
    stateDir,
    runId,
    event: "prepared",
    data: {
      contextSha256,
      taskEnvelopeSha256,
      outboundBindingVersion: 2,
      sourceRoot,
      ...(coordinated ? { routing, requiredGates: ["unit"] } : {}),
    },
    expectedSequence: 0,
    expectedState: null,
  });
  await recordEvent({
    stateDir,
    runId,
    event: "send_reserved",
    data: {
      turnId: "turn-capture",
      marker: "VISIBLE_CAPTURE",
      expectedTerminalMarker: "TERMINAL_CAPTURE_COMPLETE",
      payloadSha256: contextSha256,
      contextSha256,
      taskEnvelopeSha256,
      outboundBindingVersion: 2,
      providerNamespace: "chatgpt",
      conversationIdentity: "conversation-capture",
      ...(coordinated ? { routing: outboundRouting } : {}),
    },
    expectedSequence: 1,
    expectedState: "prepared",
    idempotencyKey: "capture-reserve",
  });
  await recordEvent({
    stateDir,
    runId,
    event: "send_confirmed",
    data: {
      turnId: "turn-capture",
      marker: "VISIBLE_CAPTURE",
      conversationIdentity: "conversation-capture",
      ...(coordinated ? { routing: outboundRouting } : {}),
      providerNamespace: "chatgpt",
      transportKind: "native-chat",
      observedAt: "2026-07-29T00:00:00.000Z",
      confirmationEvidenceClass: "thread-id-observation",
      providerMessageFingerprint: sha256("provider-message"),
      locator: { type: "thread-id", value: "provider-thread-capture" },
    },
    expectedSequence: 2,
    expectedState: "send_reserved",
    idempotencyKey: "capture-confirm",
  });
  return {
    runId,
    contextSha256,
    taskEnvelopeSha256,
    outboundRouting,
  };
}

test("terminal capture receipts bind immutable response and result bytes", async () => {
  const stateDir = await tempDir();
  const sourceRoot = await tempDir();
  const fixtureRoot = await tempDir();
  const run = await createHardenedRun(
    stateDir,
    sourceRoot,
    { coordinated: false },
  );
  const result = {
    kind: "COLLAB_RESULT_V1",
    protocolVersion: 1,
    runId: run.runId,
    turnId: "turn-capture",
    contextSha256: run.contextSha256,
    complete: true,
    artifactKind: "advisory",
    summary: "No source mutation.",
    claims: { testsRun: [] },
  };
  const resultRaw = `${JSON.stringify(result)}\n`;
  const captureRaw = [
    "Concise collaborator response.",
    "CODEX_CHAT_RESULT_BEGIN",
    JSON.stringify(result),
    "CODEX_CHAT_RESULT_END",
    "TERMINAL_CAPTURE_COMPLETE",
    "",
  ].join("\n");
  const resultPath = await writeFixture(fixtureRoot, "result.json", resultRaw);
  const capturePath = await writeFixture(fixtureRoot, "capture.txt", captureRaw);

  const receipt = await createTerminalCaptureReceipt({
    stateDir,
    runId: run.runId,
    capturePath,
    resultPath,
    scanner: "skip",
    testMode: true,
  });
  assert.equal(receipt.idempotent, false);
  assert.equal(receipt.eventData.responseSha256, sha256(captureRaw));
  assert.equal(receipt.eventData.captureSha256, sha256(captureRaw));
  assert.equal(receipt.eventData.resultEnvelopeSha256, sha256(resultRaw));
  assert.equal(
    (await createTerminalCaptureReceipt({
      stateDir,
      runId: run.runId,
      capturePath,
      resultPath,
      scanner: "skip",
      testMode: true,
    })).idempotent,
    true,
  );

  const terminal = await recordEvent({
    stateDir,
    runId: run.runId,
    event: "response_terminal",
    data: receipt.eventData,
    expectedSequence: 3,
    expectedState: "send_confirmed",
  });
  assert.equal(terminal.state.phase, "response_terminal");
  assert.equal(
    terminal.state.collaboration.responseBinding.captureReceiptSha256,
    receipt.sha256,
  );
  const slotBytes = await readFile(receipt.slotPath);
  const slot = JSON.parse(slotBytes);
  await writeFile(
    receipt.slotPath,
    `${JSON.stringify({
      ...slot,
      receiptSha256: "e".repeat(64),
    })}\n`,
  );
  await assert.rejects(
    recordEvent({
      stateDir,
      runId: run.runId,
      event: "review_started",
      expectedSequence: 4,
      expectedState: "response_terminal",
    }),
    (error) => error.code === "TERMINAL_CAPTURE_SLOT_MISMATCH",
  );
  await writeFile(receipt.slotPath, slotBytes);
  const receiptDocument = JSON.parse(await readFile(receipt.artifactPath, "utf8"));
  const captureObjectPath = path.join(
    path.dirname(path.dirname(receipt.artifactPath)),
    receiptDocument.capture.objectPath,
  );
  await writeFile(captureObjectPath, "tampered after terminal\n");
  await assert.rejects(
    recordEvent({
      stateDir,
      runId: run.runId,
      event: "review_started",
      expectedSequence: 4,
      expectedState: "response_terminal",
    }),
    (error) => error.code === "TERMINAL_CAPTURE_OBJECT_DIGEST_MISMATCH",
  );
});

test("hardened terminal events reject claims without receipts and detect object tampering", async () => {
  const stateDir = await tempDir();
  const sourceRoot = await tempDir();
  const fixtureRoot = await tempDir();
  const run = await createHardenedRun(stateDir, sourceRoot);
  await assert.rejects(
    recordEvent({
      stateDir,
      runId: run.runId,
      event: "response_terminal",
      data: {
        turnId: "turn-capture",
        terminalMarker: "TERMINAL_CAPTURE_COMPLETE",
        responseSha256: "c".repeat(64),
        resultEnvelopeSha256: "d".repeat(64),
        conversationIdentity: "conversation-capture",
        routing: run.outboundRouting,
        captureState: "terminal",
        truncated: false,
        captureSha256: "c".repeat(64),
        providerMessageFingerprint: sha256("provider-message"),
      },
      expectedSequence: 3,
      expectedState: "send_confirmed",
    }),
    (error) => error.code === "TERMINAL_CAPTURE_RECEIPT_REQUIRED",
  );

  const result = {
    kind: "COLLAB_RESULT_V1",
    protocolVersion: 1,
    runId: run.runId,
    turnId: "turn-capture",
    contextSha256: run.contextSha256,
    complete: true,
    artifactKind: "advisory",
    summary: "No source mutation.",
    claims: { testsRun: [] },
  };
  const resultRaw = `${JSON.stringify(result)}\n`;
  const captureRaw = [
    "CODEX_CHAT_RESULT_BEGIN",
    JSON.stringify(result),
    "CODEX_CHAT_RESULT_END",
    "TERMINAL_CAPTURE_COMPLETE",
    "",
  ].join("\n");
  const receipt = await createTerminalCaptureReceipt({
    stateDir,
    runId: run.runId,
    capturePath: await writeFixture(fixtureRoot, "capture.txt", captureRaw),
    resultPath: await writeFixture(fixtureRoot, "result.json", resultRaw),
    scanner: "skip",
    testMode: true,
  });
  const receiptDocument = JSON.parse(await readFile(receipt.artifactPath, "utf8"));
  const captureObjectPath = path.join(
    path.dirname(path.dirname(receipt.artifactPath)),
    receiptDocument.capture.objectPath,
  );
  await writeFile(captureObjectPath, "tampered\n");
  await assert.rejects(
    recordEvent({
      stateDir,
      runId: run.runId,
      event: "response_terminal",
      data: receipt.eventData,
      expectedSequence: 3,
      expectedState: "send_confirmed",
    }),
    (error) => error.code === "TERMINAL_CAPTURE_OBJECT_DIGEST_MISMATCH",
  );
});
