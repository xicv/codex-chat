import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildTransportManifest,
  createTransportManifest,
} from "../../.agents/skills/codex-chat/scripts/lib/transport-plan.mjs";
import { tempDir, writeFixture } from "../helpers.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function contextBytes(content = "export const answer = 42;\n") {
  return Buffer.from(`${JSON.stringify({
    kind: "COLLAB_CONTEXT_V1",
    protocolVersion: 1,
    rootLabel: "fixture",
    files: [{
      path: "src/answer.mjs",
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
      content,
    }],
  })}\n`);
}

const TASK = Buffer.from("Review the attached change carefully.\n");

test("small context produces one deterministic exact inline composer envelope", () => {
  const context = contextBytes();
  const input = {
    contextBytes: context,
    expectedContextSha256: sha256(context),
    taskEnvelopeBytes: TASK,
    expectedTaskEnvelopeSha256: sha256(TASK),
    transportKind: "ego-browser",
    uploadCapability: "unknown",
  };

  const first = buildTransportManifest(input);
  const second = buildTransportManifest(input);

  assert.deepEqual(first, second);
  assert.equal(first.strategy, "inline-context");
  assert.equal(first.failureReason, null);
  assert.equal(first.reservationEligible, true);
  assert.equal(first.actionAuthorized, false);
  assert.equal(first.resendAuthorized, false);
  assert.equal(first.modelVisible, "unknown");
  assert.equal(first.attachment.required, false);
  assert.equal(first.attachment.ordinal, null);
  assert.equal(first.composer.contextPlacement, "inline");
  assert.match(first.composer.boundaryId, /^[a-f0-9]{64}$/);
  assert.equal(first.composer.sha256, sha256(first.composer.text));
  assert.equal(first.composer.bytes, Buffer.byteLength(first.composer.text));
  assert.equal(first.composer.text.match(/CODEX_CHAT_TASK_BEGIN/g)?.length, 1);
  assert.equal(first.composer.text.match(/CODEX_CHAT_CONTEXT_BEGIN/g)?.length, 1);
  assert.match(first.composer.text, new RegExp(sha256(TASK)));
  assert.match(first.composer.text, new RegExp(sha256(context)));
  assert.ok(first.composer.text.includes(TASK.toString("utf8")));
  assert.ok(first.composer.text.includes(context.toString("utf8")));
});

test("large context selects one attachment only after upload capability is available", () => {
  const context = contextBytes("x".repeat(40 * 1024));
  const result = buildTransportManifest({
    contextBytes: context,
    expectedContextSha256: sha256(context),
    taskEnvelopeBytes: TASK,
    expectedTaskEnvelopeSha256: sha256(TASK),
    transportKind: "ego-browser",
    uploadCapability: "available",
  });

  assert.equal(result.strategy, "attachment-context");
  assert.equal(result.failureReason, null);
  assert.equal(result.reservationEligible, true);
  assert.deepEqual(result.attachment, {
    required: true,
    ordinal: 0,
    sha256: sha256(context),
    bytes: context.byteLength,
  });
  assert.equal(result.composer.contextPlacement, "attachment");
  assert.equal(result.composer.text, TASK.toString("utf8"));
  assert.equal(result.composer.sha256, sha256(TASK));
  assert.equal(result.composer.text.includes(context.toString("utf8")), false);
});

for (const capability of ["unknown", "unavailable"]) {
  test(`large context stops when upload capability is ${capability}`, () => {
    const context = contextBytes("x".repeat(40 * 1024));
    const result = buildTransportManifest({
      contextBytes: context,
      expectedContextSha256: sha256(context),
      taskEnvelopeBytes: TASK,
      expectedTaskEnvelopeSha256: sha256(TASK),
      transportKind: "codex-browser",
      uploadCapability: capability,
    });

    assert.equal(result.strategy, "stop");
    assert.equal(result.failureReason, `upload_capability_${capability}`);
    assert.equal(result.reservationEligible, false);
    assert.deepEqual(result.composer, {
      contextPlacement: "none",
      boundaryId: null,
      bytes: 0,
      sha256: null,
      text: null,
    });
    assert.equal(result.attachment.required, false);
  });
}

test("oversized task envelopes stop instead of moving instructions into an attachment", () => {
  const context = contextBytes();
  const task = Buffer.from(`${"t".repeat(33 * 1024)}\n`);
  const result = buildTransportManifest({
    contextBytes: context,
    expectedContextSha256: sha256(context),
    taskEnvelopeBytes: task,
    expectedTaskEnvelopeSha256: sha256(task),
    transportKind: "ego-browser",
    uploadCapability: "available",
  });

  assert.equal(result.strategy, "stop");
  assert.equal(result.failureReason, "task_envelope_too_large");
  assert.equal(result.reservationEligible, false);
  assert.equal(result.composer.text, null);
});

test("transport planning rejects digest drift and unsupported input fields", () => {
  const context = contextBytes();
  const input = {
    contextBytes: context,
    expectedContextSha256: sha256(context),
    taskEnvelopeBytes: TASK,
    expectedTaskEnvelopeSha256: sha256(TASK),
    transportKind: "ego-browser",
    uploadCapability: "available",
  };

  assert.throws(
    () => buildTransportManifest({
      ...input,
      expectedContextSha256: "0".repeat(64),
    }),
    { code: "TRANSPORT_CONTEXT_DIGEST_MISMATCH" },
  );
  assert.throws(
    () => buildTransportManifest({ ...input, draftText: "untrusted" }),
    { code: "TRANSPORT_PLAN_INPUT_INVALID" },
  );
});

test("transport planning rejects malformed v1-looking context internals", () => {
  const malformedValues = [
    {
      kind: "COLLAB_CONTEXT_V1",
      protocolVersion: 1,
      rootLabel: "fixture",
      files: [],
      unexpected: true,
    },
    {
      kind: "COLLAB_CONTEXT_V1",
      protocolVersion: 1,
      rootLabel: "fixture",
      files: [{
        path: "src/answer.mjs",
        bytes: 5,
        sha256: "0".repeat(64),
        content: "safe\n",
      }],
    },
    {
      kind: "COLLAB_CONTEXT_V1",
      protocolVersion: 1,
      rootLabel: "fixture",
      files: [{
        path: "src/answer.mjs",
        bytes: Buffer.byteLength("\ud800"),
        sha256: sha256(Buffer.from("\ud800")),
        content: "\ud800",
      }],
    },
  ];

  for (const value of malformedValues) {
    const context = Buffer.from(`${JSON.stringify(value)}\n`);
    assert.throws(
      () => buildTransportManifest({
        contextBytes: context,
        expectedContextSha256: sha256(context),
        taskEnvelopeBytes: TASK,
        expectedTaskEnvelopeSha256: sha256(TASK),
        transportKind: "ego-browser",
        uploadCapability: "available",
      }),
      { code: "TRANSPORT_CONTEXT_INVALID" },
    );
  }
});

test("createTransportManifest scans and publishes one create-only artifact", async () => {
  const root = await tempDir();
  const artifacts = await tempDir();
  const context = contextBytes();
  const contextPath = await writeFixture(artifacts, "context.json", context);
  const taskPath = await writeFixture(artifacts, "task.txt", TASK);
  const output = path.join(artifacts, "transport-manifest.json");

  const result = await createTransportManifest({
    root,
    contextPath,
    expectedContextSha256: sha256(context),
    taskEnvelopePath: taskPath,
    expectedTaskEnvelopeSha256: sha256(TASK),
    transportKind: "ego-browser",
    uploadCapability: "unknown",
    output,
    scanner: "skip",
    testMode: true,
  });

  const bytes = await readFile(output);
  assert.equal(
    result.artifactPath,
    path.join(await realpath(path.dirname(output)), path.basename(output)),
  );
  assert.equal(result.sha256, sha256(bytes));
  assert.equal(result.size, bytes.byteLength);
  assert.equal(result.strategy, "inline-context");
  assert.equal(JSON.parse(bytes).composer.sha256, result.composerSha256);
  await assert.rejects(
    createTransportManifest({
      root,
      contextPath,
      expectedContextSha256: sha256(context),
      taskEnvelopePath: taskPath,
      expectedTaskEnvelopeSha256: sha256(TASK),
      transportKind: "ego-browser",
      uploadCapability: "unknown",
      output,
      scanner: "skip",
      testMode: true,
    }),
    { code: "OUTPUT_EXISTS" },
  );
});

test("transport planning rejects symlinked egress inputs", async () => {
  const root = await tempDir();
  const artifacts = await tempDir();
  const context = contextBytes();
  const realContext = await writeFixture(artifacts, "real-context.json", context);
  const linkedContext = path.join(artifacts, "linked-context.json");
  await symlink(realContext, linkedContext);
  const taskPath = await writeFixture(artifacts, "task.txt", TASK);

  await assert.rejects(
    createTransportManifest({
      root,
      contextPath: linkedContext,
      expectedContextSha256: sha256(context),
      taskEnvelopePath: taskPath,
      expectedTaskEnvelopeSha256: sha256(TASK),
      transportKind: "ego-browser",
      uploadCapability: "available",
      output: path.join(artifacts, "transport-manifest.json"),
      scanner: "skip",
      testMode: true,
    }),
    { code: "TRANSPORT_CONTEXT_INVALID" },
  );
});
