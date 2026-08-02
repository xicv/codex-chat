import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  prepareCapsule,
  validateCapsule,
} from "../../.agents/skills/codex-chat/scripts/lib/capsule-preparation.mjs";
import { tempDir, writeFixture } from "../helpers.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await tempDir("codex-chat-capsule-root-");
  const parent = await tempDir("codex-chat-capsule-output-");
  const outputRoot = path.join(parent, "capsules");
  const taskRoot = await tempDir("codex-chat-capsule-task-");
  await writeFixture(root, "src/answer.mjs", "export const answer = 42;\n");
  const taskEnvelopePath = await writeFixture(
    taskRoot,
    "task.txt",
    "Review the exact context and return bounded findings.\n",
  );
  return { root, outputRoot, taskEnvelopePath };
}

function options(fx, overrides = {}) {
  return {
    root: fx.root,
    includes: ["src/answer.mjs"],
    taskEnvelopePath: fx.taskEnvelopePath,
    capsuleId: "capsule-a",
    transportKind: "browser",
    uploadCapability: "unknown",
    outputRoot: fx.outputRoot,
    scanner: "skip",
    testMode: true,
    ...overrides,
  };
}

function validationOptions(fx, prepared, overrides = {}) {
  return {
    outputRoot: fx.outputRoot,
    capsuleId: prepared.capsuleId,
    expectedReceiptSha256: prepared.receiptSha256,
    expectedTransportKind: "browser",
    expectedUploadCapability: "unknown",
    ...overrides,
  };
}

test("prepareCapsule publishes one digest-bound capsule commit last", async () => {
  const fx = await fixture();
  const result = await prepareCapsule(options(fx));

  assert.equal(result.idempotent, false);
  const receiptBytes = await readFile(result.receiptPath);
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.kind, "CODEX_CHAT_CAPSULE_V1");
  assert.equal(receipt.capsuleId, "capsule-a");
  assert.equal(result.receiptSha256, sha256(receiptBytes));

  const contextBytes = await readFile(result.context.artifactPath);
  const taskBytes = await readFile(result.taskEnvelope.artifactPath);
  const manifestBytes = await readFile(result.transportManifest.artifactPath);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(sha256(contextBytes), receipt.context.sha256);
  assert.equal(sha256(taskBytes), receipt.taskEnvelope.sha256);
  assert.equal(sha256(manifestBytes), receipt.transportManifest.sha256);
  assert.equal(manifest.context.sha256, receipt.context.sha256);
  assert.equal(manifest.taskEnvelope.sha256, receipt.taskEnvelope.sha256);
  assert.equal(manifest.transportKind, "browser");
  assert.equal(result.transportManifest.transportKind, "browser");
  assert.equal(result.transportManifest.uploadCapability, "unknown");
  assert.equal(manifest.actionAuthorized, false);

  for (const filePath of [
    result.receiptPath,
    result.context.artifactPath,
    result.taskEnvelope.artifactPath,
    result.transportManifest.artifactPath,
  ]) {
    assert.equal((await stat(filePath)).mode & 0o077, 0);
  }
});

test("validateCapsule revalidates the authoritative receipt and every object", async () => {
  const fx = await fixture();
  const prepared = await prepareCapsule(options(fx));

  const validated = await validateCapsule(validationOptions(fx, prepared));

  assert.equal(validated.valid, true);
  assert.equal(validated.receiptSha256, prepared.receiptSha256);
  assert.equal(validated.context.sha256, prepared.context.sha256);
  assert.equal(
    validated.taskEnvelope.sha256,
    prepared.taskEnvelope.sha256,
  );
  assert.equal(
    validated.transportManifest.sha256,
    prepared.transportManifest.sha256,
  );
  assert.equal(validated.actionAuthorized, false);
  assert.equal(validated.resendAuthorized, false);
});

test("validateCapsule rejects an artifact changed after receipt publication", async () => {
  const fx = await fixture();
  const prepared = await prepareCapsule(options(fx));
  await writeFixture(
    path.dirname(prepared.context.artifactPath),
    path.basename(prepared.context.artifactPath),
    "tampered\n",
  );

  await assert.rejects(
    validateCapsule(validationOptions(fx, prepared)),
    { code: "CAPSULE_CONTEXT_CONFLICT" },
  );
});

test("validateCapsule rejects a crossed selected transport", async () => {
  const fx = await fixture();
  const prepared = await prepareCapsule(options(fx));

  await assert.rejects(
    validateCapsule(validationOptions(fx, prepared, {
      expectedTransportKind: "ego-browser",
    })),
    { code: "CAPSULE_TRANSPORT_MISMATCH" },
  );
});

test("32 identical capsule writers converge on one authoritative receipt", async () => {
  const fx = await fixture();
  const results = await Promise.all(
    Array.from({ length: 32 }, () => prepareCapsule(options(fx))),
  );

  assert.equal(results.filter(({ idempotent }) => !idempotent).length, 1);
  assert.equal(results.filter(({ idempotent }) => idempotent).length, 31);
  assert.equal(new Set(results.map(({ receiptPath }) => receiptPath)).size, 1);
  assert.equal(
    new Set(results.map(({ receiptSha256 }) => receiptSha256)).size,
    1,
  );
});

test("one capsule identity rejects a divergent source snapshot", async () => {
  const fx = await fixture();
  await prepareCapsule(options(fx));
  await writeFixture(fx.root, "src/answer.mjs", "export const answer = 43;\n");

  await assert.rejects(
    prepareCapsule(options(fx)),
    { code: "CAPSULE_SLOT_CONFLICT" },
  );
});

test("capsule preparation recovers artifacts left before the commit receipt", async () => {
  const source = await fixture();
  const complete = await prepareCapsule(options(source));
  const targetParent = await tempDir("codex-chat-capsule-recovery-");
  const target = {
    ...source,
    outputRoot: path.join(targetParent, "capsules"),
  };
  await mkdir(path.join(target.outputRoot, "artifacts"), {
    recursive: true,
    mode: 0o700,
  });
  await Promise.all((await readdir(path.join(source.outputRoot, "artifacts"))).map(
    async (name) => {
      const destination = path.join(target.outputRoot, "artifacts", name);
      await copyFile(
        path.join(source.outputRoot, "artifacts", name),
        destination,
      );
      await chmod(destination, 0o600);
    },
  ));

  const recovered = await prepareCapsule(options(target));
  assert.equal(recovered.idempotent, false);
  assert.equal(recovered.receiptSha256, complete.receiptSha256);
});

test("capsule preparation rejects output nested inside the source tree", async () => {
  const fx = await fixture();
  await assert.rejects(
    prepareCapsule(options(fx, {
      outputRoot: path.join(fx.root, ".capsules"),
    })),
    { code: "CAPSULE_OUTPUT_CONFINEMENT_INVALID" },
  );
});

test("a failed capsule scan publishes no store or authoritative receipt", async () => {
  const fx = await fixture();
  const scanner = await writeFixture(
    await tempDir("codex-chat-capsule-scanner-"),
    "fake-gitleaks",
    "#!/bin/sh\nif [ \"$1\" = \"version\" ]; then echo 'fake 1.0'; exit 0; fi\nexit 11\n",
  );
  await chmod(scanner, 0o700);

  await assert.rejects(
    prepareCapsule(options(fx, { scanner })),
    { code: "SECRET_DETECTED" },
  );
  assert.equal(await stat(fx.outputRoot).then(() => true, () => false), false);
});

test("capsule IDs reject traversal before any publication work", async () => {
  const fx = await fixture();
  await assert.rejects(
    prepareCapsule(options(fx, { capsuleId: "../crossed" })),
    { code: "CAPSULE_ID_INVALID" },
  );
  assert.equal(await stat(fx.outputRoot).then(() => true, () => false), false);
});

test("capsule validation rejects malformed output roots with a stable error", async () => {
  await assert.rejects(
    validateCapsule({
      outputRoot: null,
      capsuleId: "capsule-a",
      expectedReceiptSha256: "a".repeat(64),
      expectedTransportKind: "browser",
      expectedUploadCapability: "unknown",
    }),
    { code: "CAPSULE_DIRECTORY_INVALID" },
  );
});

test("capsule validation never creates a missing evidence store", async () => {
  const parent = await tempDir("codex-chat-missing-capsule-store-");
  const outputRoot = path.join(parent, "missing");
  await assert.rejects(
    validateCapsule({
      outputRoot,
      capsuleId: "capsule-a",
      expectedReceiptSha256: "a".repeat(64),
      expectedTransportKind: "browser",
      expectedUploadCapability: "unknown",
    }),
    { code: "CAPSULE_DIRECTORY_INVALID" },
  );
  assert.equal(await stat(outputRoot).then(() => true, () => false), false);
});
