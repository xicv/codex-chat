import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fail } from "./errors.mjs";
import {
  openImmutableEvidenceStore,
  publishImmutableEvidence,
  scanImmutableEvidence,
} from "./immutable-evidence-store.mjs";
import {
  LIMITS_CAPSULE_V1,
  LIMITS_TRANSPORT_MANIFEST_V1,
} from "./limits.mjs";
import { buildPackedContext } from "./pack.mjs";
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
  if (!ID.test(capsuleId ?? "")) {
    fail(
      "CAPSULE_ID_INVALID",
      "Capsule ID must be a bounded portable protocol identity.",
    );
  }
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
  const transportManifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
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
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
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

  const store = await openImmutableEvidenceStore({
    root: canonicalOutputRoot,
    directories: ["artifacts", "capsules", ".locks"],
    codes: CODES,
  });
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
    },
    modelVisible: receipt.modelVisible,
    actionAuthorized: receipt.actionAuthorized,
    resendAuthorized: receipt.resendAuthorized,
    scanner: scan,
  };
}
