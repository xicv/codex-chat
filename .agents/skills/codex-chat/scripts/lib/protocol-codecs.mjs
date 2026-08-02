import { createHash } from "node:crypto";
import { fail } from "./errors.mjs";
import {
  LIMITS_CAPSULE_V1,
  LIMITS_TRANSPORT_MANIFEST_V1,
  LIMITS_V1,
} from "./limits.mjs";
import { isSensitivePath, validateRelativePath } from "./path-policy.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const KIND = /^[A-Z][A-Z0-9_]{2,127}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function exactKeys(value, keys) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
}

function canonicalContext(value) {
  return {
    kind: value.kind,
    protocolVersion: value.protocolVersion,
    rootLabel: value.rootLabel,
    files: value.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      content: file.content,
    })),
  };
}

function validateContext(value) {
  if (
    !exactKeys(value, ["kind", "protocolVersion", "rootLabel", "files"]) ||
    value.kind !== "COLLAB_CONTEXT_V1" ||
    value.protocolVersion !== 1 ||
    typeof value.rootLabel !== "string" ||
    value.rootLabel.length === 0 ||
    Buffer.byteLength(value.rootLabel) > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(value.rootLabel) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > LIMITS_V1.pack.maxFiles
  ) {
    fail(
      "PROTOCOL_SCHEMA_INVALID",
      "COLLAB_CONTEXT_V1 does not match its versioned protocol schema.",
    );
  }

  let totalBytes = 0;
  const paths = [];
  const collisionKeys = new Set();
  for (const file of value.files) {
    let normalizedPath = null;
    try {
      normalizedPath = validateRelativePath(file?.path);
    } catch {
      // Reframe path errors as one stable codec error.
    }
    const contentBytes = typeof file?.content === "string"
      ? Buffer.from(file.content)
      : null;
    const collisionKey = normalizedPath?.normalize("NFC")
      .toLocaleLowerCase("en-US") ?? null;
    if (
      !exactKeys(file, ["path", "bytes", "sha256", "content"]) ||
      normalizedPath === null ||
      normalizedPath !== file.path ||
      isSensitivePath(normalizedPath) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > LIMITS_V1.pack.maxFileBytes ||
      contentBytes === null ||
      contentBytes.toString("utf8") !== file.content ||
      contentBytes.byteLength !== file.bytes ||
      file.content.includes("\0") ||
      file.content.includes("\r") ||
      !SHA256.test(file.sha256 ?? "") ||
      sha256(contentBytes) !== file.sha256 ||
      collisionKey === null ||
      collisionKeys.has(collisionKey)
    ) {
      fail(
        "PROTOCOL_SCHEMA_INVALID",
        "COLLAB_CONTEXT_V1 contains an invalid file representation.",
      );
    }
    totalBytes += file.bytes;
    if (!Number.isSafeInteger(totalBytes)) {
      fail(
        "PROTOCOL_SCHEMA_INVALID",
        "COLLAB_CONTEXT_V1 aggregate size is invalid.",
      );
    }
    collisionKeys.add(collisionKey);
    paths.push(file.path);
  }
  const sortedPaths = [...paths].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  );
  if (
    totalBytes > LIMITS_V1.pack.maxTotalBytes ||
    paths.some((filePath, index) => filePath !== sortedPaths[index])
  ) {
    fail(
      "PROTOCOL_SCHEMA_INVALID",
      "COLLAB_CONTEXT_V1 file order or aggregate size is invalid.",
    );
  }
  return canonicalContext(value);
}

function canonicalTransportManifest(value) {
  return {
    kind: value.kind,
    protocolVersion: value.protocolVersion,
    transportKind: value.transportKind,
    uploadCapability: value.uploadCapability,
    strategy: value.strategy,
    failureReason: value.failureReason,
    reservationEligible: value.reservationEligible,
    context: {
      kind: value.context.kind,
      bytes: value.context.bytes,
      sha256: value.context.sha256,
    },
    taskEnvelope: {
      bytes: value.taskEnvelope.bytes,
      sha256: value.taskEnvelope.sha256,
    },
    composer: {
      contextPlacement: value.composer.contextPlacement,
      boundaryId: value.composer.boundaryId,
      bytes: value.composer.bytes,
      sha256: value.composer.sha256,
      text: value.composer.text,
    },
    attachment: {
      required: value.attachment.required,
      ordinal: value.attachment.ordinal,
      sha256: value.attachment.sha256,
      bytes: value.attachment.bytes,
    },
    thresholds: {
      maxTaskEnvelopeComposerBytes:
        value.thresholds.maxTaskEnvelopeComposerBytes,
      maxInlineContextBytes: value.thresholds.maxInlineContextBytes,
      maxInlineComposerBytes: value.thresholds.maxInlineComposerBytes,
    },
    modelVisible: value.modelVisible,
    actionAuthorized: value.actionAuthorized,
    resendAuthorized: value.resendAuthorized,
  };
}

function validNullableSha256(value) {
  return value === null || SHA256.test(value ?? "");
}

function validBoundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validateTransportManifest(value) {
  const limits = LIMITS_TRANSPORT_MANIFEST_V1;
  if (
    !exactKeys(value, [
      "kind",
      "protocolVersion",
      "transportKind",
      "uploadCapability",
      "strategy",
      "failureReason",
      "reservationEligible",
      "context",
      "taskEnvelope",
      "composer",
      "attachment",
      "thresholds",
      "modelVisible",
      "actionAuthorized",
      "resendAuthorized",
    ]) ||
    value.kind !== "CODEX_CHAT_TRANSPORT_MANIFEST_V1" ||
    value.protocolVersion !== 1 ||
    !ID.test(value.transportKind ?? "") ||
    !["available", "unavailable", "unknown"].includes(
      value.uploadCapability,
    ) ||
    !["inline-context", "attachment-context", "stop"].includes(
      value.strategy,
    ) ||
    ![null, "task_envelope_too_large", "upload_capability_unavailable",
      "upload_capability_unknown"].includes(value.failureReason) ||
    typeof value.reservationEligible !== "boolean" ||
    value.modelVisible !== "unknown" ||
    value.actionAuthorized !== false ||
    value.resendAuthorized !== false ||
    !exactKeys(value.context, ["kind", "bytes", "sha256"]) ||
    value.context.kind !== "COLLAB_CONTEXT_V1" ||
    !validBoundedInteger(value.context.bytes, 1, limits.maxContextBytes) ||
    !SHA256.test(value.context.sha256 ?? "") ||
    !exactKeys(value.taskEnvelope, ["bytes", "sha256"]) ||
    !validBoundedInteger(
      value.taskEnvelope.bytes,
      1,
      limits.maxTaskEnvelopeInputBytes,
    ) ||
    !SHA256.test(value.taskEnvelope.sha256 ?? "") ||
    !exactKeys(value.composer, [
      "contextPlacement",
      "boundaryId",
      "bytes",
      "sha256",
      "text",
    ]) ||
    !["inline", "attachment", "none"].includes(
      value.composer.contextPlacement,
    ) ||
    !validNullableSha256(value.composer.boundaryId) ||
    !validBoundedInteger(value.composer.bytes, 0, limits.maxInlineComposerBytes) ||
    !validNullableSha256(value.composer.sha256) ||
    !exactKeys(value.attachment, ["required", "ordinal", "sha256", "bytes"]) ||
    typeof value.attachment.required !== "boolean" ||
    ![null, 0].includes(value.attachment.ordinal) ||
    !validNullableSha256(value.attachment.sha256) ||
    !(
      value.attachment.bytes === null ||
      validBoundedInteger(value.attachment.bytes, 1, limits.maxContextBytes)
    ) ||
    !exactKeys(value.thresholds, [
      "maxTaskEnvelopeComposerBytes",
      "maxInlineContextBytes",
      "maxInlineComposerBytes",
    ]) ||
    value.thresholds.maxTaskEnvelopeComposerBytes !==
      limits.maxTaskEnvelopeComposerBytes ||
    value.thresholds.maxInlineContextBytes !== limits.maxInlineContextBytes ||
    value.thresholds.maxInlineComposerBytes !== limits.maxInlineComposerBytes
  ) {
    fail(
      "PROTOCOL_SCHEMA_INVALID",
      "CODEX_CHAT_TRANSPORT_MANIFEST_V1 does not match its versioned schema.",
    );
  }

  const composerText = value.composer.text;
  const composerBytes = typeof composerText === "string"
    ? Buffer.from(composerText)
    : null;
  if (
    composerBytes !== null &&
    (
      composerBytes.toString("utf8") !== composerText ||
      composerText.includes("\0") ||
      composerText.includes("\r") ||
      !composerText.endsWith("\n") ||
      composerBytes.byteLength !== value.composer.bytes ||
      sha256(composerBytes) !== value.composer.sha256
    )
  ) {
    fail(
      "PROTOCOL_SCHEMA_INVALID",
      "Transport manifest composer bytes are inconsistent.",
    );
  }

  const eligibleTask = value.taskEnvelope.bytes <=
    limits.maxTaskEnvelopeComposerBytes;
  const inline = value.strategy === "inline-context" &&
    eligibleTask &&
    value.failureReason === null &&
    value.reservationEligible === true &&
    value.context.bytes <= limits.maxInlineContextBytes &&
    value.composer.contextPlacement === "inline" &&
    SHA256.test(value.composer.boundaryId ?? "") &&
    composerBytes !== null &&
    value.attachment.required === false &&
    value.attachment.ordinal === null &&
    value.attachment.sha256 === null &&
    value.attachment.bytes === null;
  const attachment = value.strategy === "attachment-context" &&
    eligibleTask &&
    value.uploadCapability === "available" &&
    value.failureReason === null &&
    value.reservationEligible === true &&
    value.composer.contextPlacement === "attachment" &&
    value.composer.boundaryId === null &&
    composerBytes !== null &&
    value.composer.bytes === value.taskEnvelope.bytes &&
    value.composer.sha256 === value.taskEnvelope.sha256 &&
    value.attachment.required === true &&
    value.attachment.ordinal === 0 &&
    value.attachment.sha256 === value.context.sha256 &&
    value.attachment.bytes === value.context.bytes;
  const stopReasonMatches =
    (
      value.failureReason === "task_envelope_too_large" &&
      value.taskEnvelope.bytes > limits.maxTaskEnvelopeComposerBytes
    ) ||
    value.failureReason === `upload_capability_${value.uploadCapability}`;
  const stop = value.strategy === "stop" &&
    stopReasonMatches &&
    value.reservationEligible === false &&
    value.composer.contextPlacement === "none" &&
    value.composer.boundaryId === null &&
    value.composer.bytes === 0 &&
    value.composer.sha256 === null &&
    value.composer.text === null &&
    value.attachment.required === false &&
    value.attachment.ordinal === null &&
    value.attachment.sha256 === null &&
    value.attachment.bytes === null;
  if (!inline && !attachment && !stop) {
    fail(
      "PROTOCOL_RELATION_INVALID",
      "Transport manifest strategy fields are inconsistent.",
    );
  }
  return canonicalTransportManifest(value);
}

function canonicalCapsule(value) {
  return {
    kind: value.kind,
    protocolVersion: value.protocolVersion,
    capsuleId: value.capsuleId,
    context: {
      kind: value.context.kind,
      artifact: value.context.artifact,
      bytes: value.context.bytes,
      sha256: value.context.sha256,
    },
    taskEnvelope: {
      artifact: value.taskEnvelope.artifact,
      bytes: value.taskEnvelope.bytes,
      sha256: value.taskEnvelope.sha256,
    },
    transportManifest: {
      kind: value.transportManifest.kind,
      artifact: value.transportManifest.artifact,
      bytes: value.transportManifest.bytes,
      sha256: value.transportManifest.sha256,
      strategy: value.transportManifest.strategy,
      reservationEligible: value.transportManifest.reservationEligible,
      composerSha256: value.transportManifest.composerSha256,
    },
    modelVisible: value.modelVisible,
    actionAuthorized: value.actionAuthorized,
    resendAuthorized: value.resendAuthorized,
  };
}

function validateCapsule(value) {
  const transport = value?.transportManifest;
  if (
    !exactKeys(value, [
      "kind",
      "protocolVersion",
      "capsuleId",
      "context",
      "taskEnvelope",
      "transportManifest",
      "modelVisible",
      "actionAuthorized",
      "resendAuthorized",
    ]) ||
    value.kind !== "CODEX_CHAT_CAPSULE_V1" ||
    value.protocolVersion !== 1 ||
    !ID.test(value.capsuleId ?? "") ||
    value.modelVisible !== "unknown" ||
    value.actionAuthorized !== false ||
    value.resendAuthorized !== false ||
    !exactKeys(value.context, ["kind", "artifact", "bytes", "sha256"]) ||
    value.context.kind !== "COLLAB_CONTEXT_V1" ||
    !validBoundedInteger(
      value.context.bytes,
      1,
      LIMITS_TRANSPORT_MANIFEST_V1.maxContextBytes,
    ) ||
    !SHA256.test(value.context.sha256 ?? "") ||
    value.context.artifact !==
      `artifacts/context-${value.context.sha256}.json` ||
    !exactKeys(value.taskEnvelope, ["artifact", "bytes", "sha256"]) ||
    !validBoundedInteger(
      value.taskEnvelope.bytes,
      1,
      LIMITS_TRANSPORT_MANIFEST_V1.maxTaskEnvelopeInputBytes,
    ) ||
    !SHA256.test(value.taskEnvelope.sha256 ?? "") ||
    value.taskEnvelope.artifact !==
      `artifacts/task-envelope-${value.taskEnvelope.sha256}.txt` ||
    !exactKeys(transport, [
      "kind",
      "artifact",
      "bytes",
      "sha256",
      "strategy",
      "reservationEligible",
      "composerSha256",
    ]) ||
    transport.kind !== "CODEX_CHAT_TRANSPORT_MANIFEST_V1" ||
    !validBoundedInteger(
      transport.bytes,
      1,
      LIMITS_TRANSPORT_MANIFEST_V1.maxArtifactBytes,
    ) ||
    !SHA256.test(transport.sha256 ?? "") ||
    transport.artifact !==
      `artifacts/transport-manifest-${transport.sha256}.json` ||
    !["inline-context", "attachment-context", "stop"].includes(
      transport.strategy,
    ) ||
    typeof transport.reservationEligible !== "boolean" ||
    !validNullableSha256(transport.composerSha256)
  ) {
    fail(
      "PROTOCOL_SCHEMA_INVALID",
      "CODEX_CHAT_CAPSULE_V1 does not match its versioned protocol schema.",
    );
  }
  const eligible = transport.strategy !== "stop" &&
    transport.reservationEligible === true &&
    SHA256.test(transport.composerSha256 ?? "");
  const stopped = transport.strategy === "stop" &&
    transport.reservationEligible === false &&
    transport.composerSha256 === null;
  if (!eligible && !stopped) {
    fail(
      "PROTOCOL_RELATION_INVALID",
      "Capsule transport strategy fields are inconsistent.",
    );
  }
  return canonicalCapsule(value);
}

const CODECS = Object.freeze({
  COLLAB_CONTEXT_V1: Object.freeze({
    protocolVersion: 1,
    maxBytes: LIMITS_V1.pack.maxArtifactBytes,
    validate: validateContext,
  }),
  CODEX_CHAT_TRANSPORT_MANIFEST_V1: Object.freeze({
    protocolVersion: 1,
    maxBytes: LIMITS_TRANSPORT_MANIFEST_V1.maxArtifactBytes,
    validate: validateTransportManifest,
  }),
  CODEX_CHAT_CAPSULE_V1: Object.freeze({
    protocolVersion: 1,
    maxBytes: LIMITS_CAPSULE_V1.maxReceiptBytes,
    validate: validateCapsule,
  }),
});

function codecFor(kind) {
  if (!KIND.test(kind ?? "") || !Object.hasOwn(CODECS, kind)) {
    fail("PROTOCOL_KIND_UNSUPPORTED", "Protocol artifact kind is unsupported.");
  }
  return CODECS[kind];
}

function serializedProtocol(value) {
  const codec = codecFor(value?.kind);
  if (value?.protocolVersion !== codec.protocolVersion) {
    fail(
      "PROTOCOL_VERSION_UNSUPPORTED",
      "Protocol artifact version is unsupported for its kind.",
    );
  }
  const canonical = codec.validate(value);
  const bytes = Buffer.from(`${JSON.stringify(canonical)}\n`);
  if (bytes.byteLength > codec.maxBytes) {
    fail("PROTOCOL_TOO_LARGE", "Protocol artifact exceeds its versioned byte limit.");
  }
  return { bytes, canonical };
}

export function encodeProtocolArtifact(value) {
  return serializedProtocol(value).bytes;
}

export function decodeProtocolArtifact(bytes, { expectedKind } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    fail("PROTOCOL_INPUT_INVALID", "Protocol artifact must be non-empty bytes.");
  }
  const expectedCodec = codecFor(expectedKind);
  if (bytes.byteLength > expectedCodec.maxBytes) {
    fail("PROTOCOL_TOO_LARGE", "Protocol artifact exceeds its versioned byte limit.");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("PROTOCOL_UTF8_INVALID", "Protocol artifact must be valid UTF-8.");
  }
  if (text.includes("\0") || text.includes("\r") || !text.endsWith("\n")) {
    fail(
      "PROTOCOL_TEXT_INVALID",
      "Protocol artifact must be NUL-free UTF-8/LF ending in LF.",
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("PROTOCOL_JSON_INVALID", "Protocol artifact must contain valid JSON.");
  }
  if (value?.kind !== expectedKind) {
    fail("PROTOCOL_KIND_MISMATCH", "Protocol artifact kind does not match.");
  }
  const serialized = serializedProtocol(value);
  if (!serialized.bytes.equals(Buffer.from(bytes))) {
    fail(
      "PROTOCOL_CANONICAL_INVALID",
      "Protocol artifact is not in canonical versioned form.",
    );
  }
  return serialized.canonical;
}
