import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fail } from "./errors.mjs";
import {
  openImmutableEvidenceStore,
  publishImmutableEvidence,
  readImmutableEvidence,
  scanImmutableEvidence,
} from "./immutable-evidence-store.mjs";
import {
  LIMITS_CAPSULE_V1,
  LIMITS_TRANSPORT_MANIFEST_V1,
} from "./limits.mjs";
import { buildPackedContext } from "./pack.mjs";
import {
  decodeProtocolArtifact,
  encodeProtocolArtifact,
} from "./protocol-codecs.mjs";
import {
  buildTransportManifest,
  readBoundedTransportFile,
} from "./transport-plan.mjs";

const CODES = Object.freeze({
  directoryInvalid: "CAPSULE_DIRECTORY_INVALID",
  parentChanged: "CAPSULE_PARENT_CHANGED",
  slotBusy: "CAPSULE_SLOT_BUSY",
  slotConflict: "CAPSULE_SLOT_CONFLICT",
});
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function isWithin(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function validateOutputRoot(canonicalSourceRoot, outputRoot) {
  if (
    typeof outputRoot !== "string" ||
    outputRoot.length === 0 ||
    Buffer.byteLength(outputRoot) > 4096
  ) {
    fail("CAPSULE_DIRECTORY_INVALID", "Capsule output root path is invalid.");
  }
  const requested = path.resolve(outputRoot);
  const parent = path.dirname(requested);
  const parentInfo = await lstat(parent).catch(() => null);
  if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) {
    fail(
      "CAPSULE_DIRECTORY_INVALID",
      "Capsule output parent must be an existing real directory.",
    );
  }
  const target = path.join(await realpath(parent), path.basename(requested));
  if (isWithin(canonicalSourceRoot, target)) {
    fail(
      "CAPSULE_OUTPUT_CONFINEMENT_INVALID",
      "Capsule output root must be outside the source root.",
    );
  }
  return target;
}

function artifactPath(kind, digest, extension) {
  return `artifacts/${kind}-${digest}.${extension}`;
}

function validatedCapsuleId(capsuleId) {
  if (!ID.test(capsuleId ?? "")) {
    fail(
      "CAPSULE_ID_INVALID",
      "Capsule ID must be a bounded portable protocol identity.",
    );
  }
  return capsuleId;
}

async function openCapsuleStore(outputRoot, { create = true } = {}) {
  if (
    typeof outputRoot !== "string" ||
    outputRoot.length === 0 ||
    Buffer.byteLength(outputRoot) > 4096
  ) {
    fail("CAPSULE_DIRECTORY_INVALID", "Capsule output root path is invalid.");
  }
  return openImmutableEvidenceStore({
    root: path.resolve(outputRoot),
    directories: ["artifacts", "capsules", ".locks"],
    codes: CODES,
    create,
  });
}

export async function prepareCapsule({
  root,
  includes,
  taskEnvelopePath,
  capsuleId,
  transportKind,
  uploadCapability,
  outputRoot,
  scanner = "gitleaks",
  testMode = false,
}) {
  validatedCapsuleId(capsuleId);
  const [packed, taskEnvelopeBytes] = await Promise.all([
    buildPackedContext({ root, includes, testMode }),
    readBoundedTransportFile(
      taskEnvelopePath,
      "CAPSULE_TASK_ENVELOPE",
      LIMITS_TRANSPORT_MANIFEST_V1.maxTaskEnvelopeInputBytes,
    ),
  ]);
  const canonicalOutputRoot = await validateOutputRoot(
    packed.canonicalRoot,
    outputRoot,
  );
  const manifest = buildTransportManifest({
    contextBytes: packed.bytes,
    expectedContextSha256: packed.sha256,
    taskEnvelopeBytes,
    expectedTaskEnvelopeSha256: sha256(taskEnvelopeBytes),
    transportKind,
    uploadCapability,
  });
  const transportManifestBytes = encodeProtocolArtifact(manifest);
  if (
    transportManifestBytes.byteLength >
    LIMITS_TRANSPORT_MANIFEST_V1.maxArtifactBytes
  ) {
    fail(
      "TRANSPORT_MANIFEST_TOO_LARGE",
      `Transport manifest exceeds ${LIMITS_TRANSPORT_MANIFEST_V1.maxArtifactBytes} bytes.`,
    );
  }

  const taskEnvelopeSha256 = sha256(taskEnvelopeBytes);
  const transportManifestSha256 = sha256(transportManifestBytes);
  const contextRelativePath = artifactPath("context", packed.sha256, "json");
  const taskRelativePath = artifactPath(
    "task-envelope",
    taskEnvelopeSha256,
    "txt",
  );
  const transportRelativePath = artifactPath(
    "transport-manifest",
    transportManifestSha256,
    "json",
  );
  const receipt = {
    kind: "CODEX_CHAT_CAPSULE_V1",
    protocolVersion: 1,
    capsuleId,
    context: {
      kind: "COLLAB_CONTEXT_V1",
      artifact: contextRelativePath,
      bytes: packed.size,
      sha256: packed.sha256,
    },
    taskEnvelope: {
      artifact: taskRelativePath,
      bytes: taskEnvelopeBytes.byteLength,
      sha256: taskEnvelopeSha256,
    },
    transportManifest: {
      kind: "CODEX_CHAT_TRANSPORT_MANIFEST_V1",
      artifact: transportRelativePath,
      bytes: transportManifestBytes.byteLength,
      sha256: transportManifestSha256,
      strategy: manifest.strategy,
      reservationEligible: manifest.reservationEligible,
      composerSha256: manifest.composer.sha256,
    },
    modelVisible: "unknown",
    actionAuthorized: false,
    resendAuthorized: false,
  };
  const receiptBytes = encodeProtocolArtifact(receipt);
  if (receiptBytes.byteLength > LIMITS_CAPSULE_V1.maxReceiptBytes) {
    fail(
      "CAPSULE_RECEIPT_TOO_LARGE",
      `Capsule receipt exceeds ${LIMITS_CAPSULE_V1.maxReceiptBytes} bytes.`,
    );
  }

  const scan = await scanImmutableEvidence({
    entries: [
      { name: "context.json", bytes: packed.bytes },
      { name: "task-envelope.txt", bytes: taskEnvelopeBytes },
      { name: "transport-manifest.json", bytes: transportManifestBytes },
      { name: "capsule-receipt.json", bytes: receiptBytes },
    ],
    scanner,
    testMode,
    prefix: "codex-chat-capsule-scan-",
  });

  const store = await openCapsuleStore(canonicalOutputRoot);
  const publication = await publishImmutableEvidence({
    store,
    slotId: capsuleId,
    slot: {
      relativePath: `capsules/${capsuleId}.json`,
      bytes: receiptBytes,
      maxBytes: LIMITS_CAPSULE_V1.maxReceiptBytes,
    },
    artifacts: [
      {
        relativePath: contextRelativePath,
        bytes: packed.bytes,
        maxBytes: LIMITS_TRANSPORT_MANIFEST_V1.maxContextBytes,
        conflictCode: "CAPSULE_CONTEXT_CONFLICT",
      },
      {
        relativePath: taskRelativePath,
        bytes: taskEnvelopeBytes,
        maxBytes: LIMITS_TRANSPORT_MANIFEST_V1.maxTaskEnvelopeInputBytes,
        conflictCode: "CAPSULE_TASK_ENVELOPE_CONFLICT",
      },
      {
        relativePath: transportRelativePath,
        bytes: transportManifestBytes,
        maxBytes: LIMITS_TRANSPORT_MANIFEST_V1.maxArtifactBytes,
        conflictCode: "CAPSULE_TRANSPORT_MANIFEST_CONFLICT",
      },
    ],
  });

  return {
    capsuleId,
    receiptPath: publication.slotPath,
    receiptSha256: sha256(receiptBytes),
    idempotent: publication.idempotent,
    context: {
      artifactPath: publication.artifactPaths[contextRelativePath],
      size: packed.size,
      sha256: packed.sha256,
      sourceBytes: packed.sourceBytes,
      files: packed.files,
    },
    taskEnvelope: {
      artifactPath: publication.artifactPaths[taskRelativePath],
      size: taskEnvelopeBytes.byteLength,
      sha256: taskEnvelopeSha256,
    },
    transportManifest: {
      artifactPath: publication.artifactPaths[transportRelativePath],
      size: transportManifestBytes.byteLength,
      sha256: transportManifestSha256,
      strategy: manifest.strategy,
      failureReason: manifest.failureReason,
      reservationEligible: manifest.reservationEligible,
      composerSha256: manifest.composer.sha256,
      transportKind: manifest.transportKind,
      uploadCapability: manifest.uploadCapability,
    },
    modelVisible: receipt.modelVisible,
    actionAuthorized: receipt.actionAuthorized,
    resendAuthorized: receipt.resendAuthorized,
    scanner: scan,
  };
}

function assertArtifact(receiptEntry, evidence, conflictCode) {
  if (
    evidence.bytes.byteLength !== receiptEntry.bytes ||
    sha256(evidence.bytes) !== receiptEntry.sha256
  ) {
    fail(conflictCode, "Capsule artifact bytes do not match the receipt.");
  }
}

function validateTaskEnvelope(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(
      "CAPSULE_TASK_ENVELOPE_CONFLICT",
      "Capsule task envelope is not valid UTF-8.",
    );
  }
  if (text.includes("\0") || text.includes("\r") || !text.endsWith("\n")) {
    fail(
      "CAPSULE_TASK_ENVELOPE_CONFLICT",
      "Capsule task envelope is not canonical UTF-8/LF text.",
    );
  }
}

export async function validateCapsule({
  outputRoot,
  capsuleId,
  expectedReceiptSha256,
  expectedTransportKind,
  expectedUploadCapability,
}) {
  validatedCapsuleId(capsuleId);
  if (!/^[a-f0-9]{64}$/u.test(expectedReceiptSha256 ?? "")) {
    fail(
      "CAPSULE_RECEIPT_DIGEST_INVALID",
      "Expected capsule receipt SHA-256 is invalid.",
    );
  }
  if (
    !ID.test(expectedTransportKind ?? "") ||
    !["available", "unavailable", "unknown"].includes(
      expectedUploadCapability,
    )
  ) {
    fail(
      "CAPSULE_TRANSPORT_EXPECTATION_INVALID",
      "Expected capsule transport selection is invalid.",
    );
  }
  const store = await openCapsuleStore(outputRoot, { create: false });
  const receiptEvidence = await readImmutableEvidence({
    store,
    relativePath: `capsules/${capsuleId}.json`,
    maxBytes: LIMITS_CAPSULE_V1.maxReceiptBytes,
    conflictCode: "CAPSULE_RECEIPT_CONFLICT",
  });
  const receiptSha256 = sha256(receiptEvidence.bytes);
  if (receiptSha256 !== expectedReceiptSha256) {
    fail(
      "CAPSULE_RECEIPT_DIGEST_MISMATCH",
      "Capsule receipt does not match its expected SHA-256.",
    );
  }
  const receipt = decodeProtocolArtifact(receiptEvidence.bytes, {
    expectedKind: "CODEX_CHAT_CAPSULE_V1",
  });
  if (receipt.capsuleId !== capsuleId) {
    fail(
      "CAPSULE_RECEIPT_CONFLICT",
      "Capsule receipt is bound to a different capsule identity.",
    );
  }

  const [contextEvidence, taskEvidence, transportEvidence] = await Promise.all([
    readImmutableEvidence({
      store,
      relativePath: receipt.context.artifact,
      maxBytes: LIMITS_TRANSPORT_MANIFEST_V1.maxContextBytes,
      conflictCode: "CAPSULE_CONTEXT_CONFLICT",
    }),
    readImmutableEvidence({
      store,
      relativePath: receipt.taskEnvelope.artifact,
      maxBytes: LIMITS_TRANSPORT_MANIFEST_V1.maxTaskEnvelopeInputBytes,
      conflictCode: "CAPSULE_TASK_ENVELOPE_CONFLICT",
    }),
    readImmutableEvidence({
      store,
      relativePath: receipt.transportManifest.artifact,
      maxBytes: LIMITS_TRANSPORT_MANIFEST_V1.maxArtifactBytes,
      conflictCode: "CAPSULE_TRANSPORT_MANIFEST_CONFLICT",
    }),
  ]);
  assertArtifact(receipt.context, contextEvidence, "CAPSULE_CONTEXT_CONFLICT");
  assertArtifact(
    receipt.taskEnvelope,
    taskEvidence,
    "CAPSULE_TASK_ENVELOPE_CONFLICT",
  );
  assertArtifact(
    receipt.transportManifest,
    transportEvidence,
    "CAPSULE_TRANSPORT_MANIFEST_CONFLICT",
  );
  decodeProtocolArtifact(contextEvidence.bytes, {
    expectedKind: "COLLAB_CONTEXT_V1",
  });
  validateTaskEnvelope(taskEvidence.bytes);
  const transport = decodeProtocolArtifact(transportEvidence.bytes, {
    expectedKind: "CODEX_CHAT_TRANSPORT_MANIFEST_V1",
  });
  if (
    transport.transportKind !== expectedTransportKind ||
    transport.uploadCapability !== expectedUploadCapability
  ) {
    fail(
      "CAPSULE_TRANSPORT_MISMATCH",
      "Capsule transport differs from the selected transport.",
    );
  }
  const rebuiltTransportBytes = encodeProtocolArtifact(buildTransportManifest({
    contextBytes: contextEvidence.bytes,
    expectedContextSha256: receipt.context.sha256,
    taskEnvelopeBytes: taskEvidence.bytes,
    expectedTaskEnvelopeSha256: receipt.taskEnvelope.sha256,
    transportKind: expectedTransportKind,
    uploadCapability: expectedUploadCapability,
  }));
  if (!rebuiltTransportBytes.equals(transportEvidence.bytes)) {
    fail(
      "CAPSULE_BINDING_MISMATCH",
      "Capsule transport manifest is not derived from its bound inputs.",
    );
  }
  if (
    transport.context.bytes !== receipt.context.bytes ||
    transport.context.sha256 !== receipt.context.sha256 ||
    transport.taskEnvelope.bytes !== receipt.taskEnvelope.bytes ||
    transport.taskEnvelope.sha256 !== receipt.taskEnvelope.sha256 ||
    transport.strategy !== receipt.transportManifest.strategy ||
    transport.reservationEligible !==
      receipt.transportManifest.reservationEligible ||
    transport.composer.sha256 !== receipt.transportManifest.composerSha256
  ) {
    fail(
      "CAPSULE_BINDING_MISMATCH",
      "Capsule receipt and transport manifest bindings differ.",
    );
  }

  return {
    valid: true,
    capsuleId,
    receiptPath: receiptEvidence.path,
    receiptSha256,
    context: {
      artifactPath: contextEvidence.path,
      bytes: receipt.context.bytes,
      sha256: receipt.context.sha256,
    },
    taskEnvelope: {
      artifactPath: taskEvidence.path,
      bytes: receipt.taskEnvelope.bytes,
      sha256: receipt.taskEnvelope.sha256,
    },
    transportManifest: {
      artifactPath: transportEvidence.path,
      bytes: receipt.transportManifest.bytes,
      sha256: receipt.transportManifest.sha256,
      strategy: receipt.transportManifest.strategy,
      reservationEligible: receipt.transportManifest.reservationEligible,
      composerSha256: receipt.transportManifest.composerSha256,
      transportKind: transport.transportKind,
      uploadCapability: transport.uploadCapability,
    },
    modelVisible: receipt.modelVisible,
    actionAuthorized: receipt.actionAuthorized,
    resendAuthorized: receipt.resendAuthorized,
  };
}
