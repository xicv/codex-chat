import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  decodeProtocolArtifact,
  encodeProtocolArtifact,
} from "../../.agents/skills/codex-chat/scripts/lib/protocol-codecs.mjs";
import {
  buildTransportManifest,
} from "../../.agents/skills/codex-chat/scripts/lib/transport-plan.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function contextValue() {
  const source = "export const answer = 42;\n";
  return {
    kind: "COLLAB_CONTEXT_V1",
    protocolVersion: 1,
    rootLabel: "codec-fixture",
    files: [{
      path: "src/answer.mjs",
      bytes: Buffer.byteLength(source),
      sha256: sha256(source),
      content: source,
    }],
  };
}

test("the protocol codec round-trips one canonical COLLAB_CONTEXT_V1 artifact", () => {
  const value = contextValue();

  const encoded = encodeProtocolArtifact(value);
  assert.equal(encoded.toString("utf8"), `${JSON.stringify(value)}\n`);
  assert.deepEqual(
    decodeProtocolArtifact(encoded, { expectedKind: "COLLAB_CONTEXT_V1" }),
    value,
  );
});

test("the protocol codec round-trips one size-aware transport manifest", () => {
  const contextBytes = encodeProtocolArtifact(contextValue());
  const taskEnvelopeBytes = Buffer.from("Review this exact context.\n");
  const value = buildTransportManifest({
    contextBytes,
    expectedContextSha256: sha256(contextBytes),
    taskEnvelopeBytes,
    expectedTaskEnvelopeSha256: sha256(taskEnvelopeBytes),
    transportKind: "browser",
    uploadCapability: "unknown",
  });

  const encoded = encodeProtocolArtifact(value);
  assert.deepEqual(
    decodeProtocolArtifact(encoded, {
      expectedKind: "CODEX_CHAT_TRANSPORT_MANIFEST_V1",
    }),
    value,
  );
});

test("the protocol codec round-trips one authoritative capsule receipt", () => {
  const contextBytes = encodeProtocolArtifact(contextValue());
  const taskEnvelopeBytes = Buffer.from("Review this exact context.\n");
  const transportManifest = buildTransportManifest({
    contextBytes,
    expectedContextSha256: sha256(contextBytes),
    taskEnvelopeBytes,
    expectedTaskEnvelopeSha256: sha256(taskEnvelopeBytes),
    transportKind: "browser",
    uploadCapability: "unknown",
  });
  const transportManifestBytes = encodeProtocolArtifact(transportManifest);
  const contextSha256 = sha256(contextBytes);
  const taskEnvelopeSha256 = sha256(taskEnvelopeBytes);
  const transportManifestSha256 = sha256(transportManifestBytes);
  const value = {
    kind: "CODEX_CHAT_CAPSULE_V1",
    protocolVersion: 1,
    capsuleId: "codec-capsule",
    context: {
      kind: "COLLAB_CONTEXT_V1",
      artifact: `artifacts/context-${contextSha256}.json`,
      bytes: contextBytes.byteLength,
      sha256: contextSha256,
    },
    taskEnvelope: {
      artifact: `artifacts/task-envelope-${taskEnvelopeSha256}.txt`,
      bytes: taskEnvelopeBytes.byteLength,
      sha256: taskEnvelopeSha256,
    },
    transportManifest: {
      kind: "CODEX_CHAT_TRANSPORT_MANIFEST_V1",
      artifact:
        `artifacts/transport-manifest-${transportManifestSha256}.json`,
      bytes: transportManifestBytes.byteLength,
      sha256: transportManifestSha256,
      strategy: transportManifest.strategy,
      reservationEligible: transportManifest.reservationEligible,
      composerSha256: transportManifest.composer.sha256,
    },
    modelVisible: "unknown",
    actionAuthorized: false,
    resendAuthorized: false,
  };

  const encoded = encodeProtocolArtifact(value);
  assert.deepEqual(
    decodeProtocolArtifact(encoded, {
      expectedKind: "CODEX_CHAT_CAPSULE_V1",
    }),
    value,
  );
});

test("the protocol codec rejects an unsupported protocol version distinctly", () => {
  const unsupported = Buffer.from(`${JSON.stringify({
    kind: "COLLAB_CONTEXT_V1",
    protocolVersion: 2,
    rootLabel: "codec-fixture",
    files: [],
  })}\n`);

  assert.throws(
    () => decodeProtocolArtifact(unsupported, {
      expectedKind: "COLLAB_CONTEXT_V1",
    }),
    { code: "PROTOCOL_VERSION_UNSUPPORTED" },
  );
});

test("the protocol codec rejects noncanonical field order", () => {
  const canonical = contextValue();
  const reordered = Buffer.from(`${JSON.stringify({
    protocolVersion: canonical.protocolVersion,
    kind: canonical.kind,
    rootLabel: canonical.rootLabel,
    files: canonical.files,
  })}\n`);

  assert.throws(
    () => decodeProtocolArtifact(reordered, {
      expectedKind: "COLLAB_CONTEXT_V1",
    }),
    { code: "PROTOCOL_CANONICAL_INVALID" },
  );
});

test("the protocol codec rejects crossed transport strategy fields", () => {
  const contextBytes = encodeProtocolArtifact(contextValue());
  const taskEnvelopeBytes = Buffer.from("Review this exact context.\n");
  const manifest = buildTransportManifest({
    contextBytes,
    expectedContextSha256: sha256(contextBytes),
    taskEnvelopeBytes,
    expectedTaskEnvelopeSha256: sha256(taskEnvelopeBytes),
    transportKind: "browser",
    uploadCapability: "unknown",
  });

  assert.throws(
    () => encodeProtocolArtifact({
      ...manifest,
      reservationEligible: false,
    }),
    { code: "PROTOCOL_RELATION_INVALID" },
  );
});

test("the protocol codec reframes a null context path as a stable schema error", () => {
  const value = contextValue();
  value.files[0].path = null;

  assert.throws(
    () => encodeProtocolArtifact(value),
    { code: "PROTOCOL_SCHEMA_INVALID" },
  );
});

test("the protocol codec rejects an eligible oversized task envelope", () => {
  const contextBytes = encodeProtocolArtifact(contextValue());
  const taskEnvelopeBytes = Buffer.from("Review this exact context.\n");
  const manifest = buildTransportManifest({
    contextBytes,
    expectedContextSha256: sha256(contextBytes),
    taskEnvelopeBytes,
    expectedTaskEnvelopeSha256: sha256(taskEnvelopeBytes),
    transportKind: "browser",
    uploadCapability: "unknown",
  });

  assert.throws(
    () => encodeProtocolArtifact({
      ...manifest,
      taskEnvelope: {
        ...manifest.taskEnvelope,
        bytes: manifest.thresholds.maxTaskEnvelopeComposerBytes + 1,
      },
    }),
    { code: "PROTOCOL_RELATION_INVALID" },
  );
});
