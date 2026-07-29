import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fail } from "./errors.mjs";
import { withOwnedFileLock } from "./file-lock.mjs";
import { LIMITS_V2 } from "./limits.mjs";
import { atomicWrite } from "./pack.mjs";
import { scanDirectory } from "./scanner.mjs";
import { loadRun, statePaths } from "./state.mjs";

const {
  maxManifestBytes: MAX_MANIFEST_BYTES,
  maxPlanBytes: MAX_PLAN_BYTES,
  maxEvidenceBytes: MAX_EVIDENCE_BYTES,
  maxArtifactBytes: MAX_RECEIPT_BYTES,
  maxRepresentations: MAX_REPRESENTATIONS,
  maxProviderIdBytes: MAX_PROVIDER_ID_BYTES,
} = LIMITS_V2.delivery;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const MODALITIES = new Set([
  "code",
  "text",
  "image",
  "pdf",
  "document",
  "spreadsheet",
  "data",
]);
const TEXT_MODALITIES = new Set(["code", "text", "data"]);
const FIDELITY = new Set(["exact", "lossless", "lossy"]);
const STATUSES = new Set(["accepted", "rejected"]);
const DETAILS = new Set([
  "not-applicable",
  "original",
  "low",
  "high",
  "auto",
  "provider-default",
]);
const EVIDENCE_KINDS = new Set([
  "exact-payload",
  "inline-text",
  "provider-metadata",
  "ui-capture",
]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stable(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validRouting(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ["workspaceId", "coordinatorId", "workUnitId", "agentId"].every((key) =>
      ID.test(value[key] ?? "")
    ) &&
    Object.keys(value).every((key) =>
      ["workspaceId", "coordinatorId", "workUnitId", "agentId"].includes(key)
    )
  );
}

function validManifestLocator(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ID.test(value.space ?? "") &&
    typeof value.value === "string" &&
    value.value.length > 0 &&
    Buffer.byteLength(value.value) <= 4096 &&
    Object.keys(value).every((key) => ["space", "value"].includes(key))
  );
}

function validOptionalLocator(value) {
  return value === null || validManifestLocator(value);
}

function validTransportLocator(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ID.test(value.type ?? "") &&
    boundedString(value.value) &&
    Object.keys(value).every((key) => ["type", "value"].includes(key))
  );
}

function boundedString(value, maxBytes = 4096) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maxBytes
  );
}

function validObservedAt(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validStringList(value) {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((item) => boundedString(item))
  );
}

function validParent(value) {
  return (
    value === null ||
    (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      SHA256.test(value.contextSha256 ?? "") &&
      ID.test(value.turnId ?? "") &&
      Object.keys(value).every((key) =>
        ["contextSha256", "turnId"].includes(key)
      )
    )
  );
}

function validCheckpoint(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    boundedString(value.goal) &&
    validStringList(value.invariants) &&
    validStringList(value.decisions) &&
    validStringList(value.unresolved) &&
    ["unverified", "partial", "verified"].includes(value.verificationStatus) &&
    Object.keys(value).every((key) =>
      [
        "goal",
        "invariants",
        "decisions",
        "unresolved",
        "verificationStatus",
      ].includes(key)
    )
  );
}

function validTransform(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    boundedString(value.tool) &&
    boundedString(value.version) &&
    value.parameters &&
    typeof value.parameters === "object" &&
    !Array.isArray(value.parameters) &&
    boundedString(value.coverage) &&
    typeof value.truncated === "boolean" &&
    Object.keys(value).every((key) =>
      ["tool", "version", "parameters", "coverage", "truncated"].includes(key)
    )
  );
}

function validText(value) {
  return (
    value === null ||
    (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.charset === "utf-8" &&
      typeof value.bom === "boolean" &&
      ["none", "lf", "cr", "crlf", "mixed"].includes(value.lineEndings) &&
      Object.keys(value).every((key) =>
        ["charset", "bom", "lineEndings"].includes(key)
      )
    )
  );
}

function validStagedDelivery(value) {
  const fields = [
    "status",
    "modelVisible",
    "transport",
    "conversationIdentity",
    "turnId",
    "providerAttachmentId",
    "providerFingerprint",
  ];
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.status === "staged" &&
    value.modelVisible === "unknown" &&
    value.transport === null &&
    value.conversationIdentity === null &&
    value.turnId === null &&
    value.providerAttachmentId === null &&
    value.providerFingerprint === null &&
    Object.keys(value).every((key) => fields.includes(key))
  );
}

function validManifestRepresentation(value) {
  const fields = [
    "representationId",
    "path",
    "modality",
    "mediaType",
    "role",
    "purpose",
    "bytes",
    "sha256",
    "fidelity",
    "sourceRepresentationId",
    "sourceSha256",
    "locator",
    "transform",
    "text",
    "delivery",
  ];
  const derived = value?.sourceRepresentationId !== null;
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ID.test(value.representationId ?? "") &&
    boundedString(value.path) &&
    MODALITIES.has(value.modality) &&
    MEDIA_TYPE.test(value.mediaType ?? "") &&
    boundedString(value.role) &&
    boundedString(value.purpose) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    SHA256.test(value.sha256 ?? "") &&
    FIDELITY.has(value.fidelity) &&
    validOptionalLocator(value.locator) &&
    validText(value.text) &&
    validStagedDelivery(value.delivery) &&
    (
      TEXT_MODALITIES.has(value.modality)
        ? value.text !== null
        : value.text === null
    ) &&
    (
      derived
        ? (
            ID.test(value.sourceRepresentationId ?? "") &&
            SHA256.test(value.sourceSha256 ?? "") &&
            value.fidelity !== "exact" &&
            validTransform(value.transform)
          )
        : (
            value.sourceSha256 === null &&
            value.fidelity === "exact" &&
            value.transform === null
          )
    ) &&
    Object.keys(value).every((key) => fields.includes(key))
  );
}

async function readRealFile(filePath, label, maxBytes) {
  const absolute = path.resolve(filePath);
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => null);
  if (!handle) {
    fail(`${label}_INVALID`, `${label.replaceAll("_", " ")} must be a real file.`);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      fail(
        `${label}_INVALID`,
        `${label.replaceAll("_", " ")} must be a real file.`,
      );
    }
    if (before.size > maxBytes) {
      fail(
        `${label}_TOO_LARGE`,
        `${label.replaceAll("_", " ")} exceeds ${maxBytes} bytes.`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength > maxBytes ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.byteLength !== after.size
    ) {
      fail(
        `${label}_CHANGED`,
        `${label.replaceAll("_", " ")} changed while it was read.`,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseJson(bytes, code, message) {
  let contents;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code, `${message} is not valid UTF-8.`);
  }
  try {
    return JSON.parse(contents);
  } catch {
    fail(code, `${message} is not valid JSON.`);
  }
}

function parseManifest(bytes) {
  const manifest = parseJson(
    bytes,
    "DELIVERY_MANIFEST_INVALID",
    "Delivery manifest",
  );
  if (
    manifest?.kind !== "COLLAB_CONTEXT_MANIFEST_V2" ||
    manifest.protocolVersion !== 2 ||
    !boundedString(manifest.rootLabel) ||
    !SHA256.test(manifest.planSha256 ?? "") ||
    !validRouting(manifest.routing) ||
    !ID.test(manifest.checkpointNamespace ?? "") ||
    !validParent(manifest.parent) ||
    !validCheckpoint(manifest.checkpoint) ||
    !Array.isArray(manifest.representations) ||
    manifest.representations.length === 0 ||
    manifest.representations.length > MAX_REPRESENTATIONS ||
    Object.keys(manifest).some((key) =>
      ![
        "kind",
        "protocolVersion",
        "rootLabel",
        "planSha256",
        "routing",
        "checkpointNamespace",
        "parent",
        "checkpoint",
        "representations",
      ].includes(key)
    )
  ) {
    fail(
      "DELIVERY_MANIFEST_INVALID",
      "Delivery manifest does not match the required v2 context contract.",
    );
  }
  const ids = new Set();
  for (const representation of manifest.representations) {
    if (
      !validManifestRepresentation(representation) ||
      ids.has(representation.representationId)
    ) {
      fail(
        "DELIVERY_MANIFEST_INVALID",
        "Delivery manifest contains an invalid representation binding.",
      );
    }
    ids.add(representation.representationId);
  }
  const byId = new Map(manifest.representations.map((item) => [
    item.representationId,
    item,
  ]));
  for (const representation of manifest.representations) {
    if (representation.sourceRepresentationId === null) continue;
    const source = byId.get(representation.sourceRepresentationId);
    if (!source || representation.sourceSha256 !== source.sha256) {
      fail(
        "DELIVERY_MANIFEST_INVALID",
        "Delivery manifest contains an invalid source representation binding.",
      );
    }
    const visited = new Set();
    let current = representation;
    while (current.sourceRepresentationId !== null) {
      if (visited.has(current.representationId)) {
        fail(
          "DELIVERY_MANIFEST_INVALID",
          "Delivery manifest representation provenance contains a cycle.",
        );
      }
      visited.add(current.representationId);
      current = byId.get(current.sourceRepresentationId);
      if (!current) {
        fail(
          "DELIVERY_MANIFEST_INVALID",
          "Delivery manifest contains a missing source representation.",
        );
      }
    }
  }
  return manifest;
}

function optionalProviderId(value) {
  return value === null || boundedString(value, MAX_PROVIDER_ID_BYTES);
}

function optionalSha256(value) {
  return value === null || SHA256.test(value ?? "");
}

function validDeliveryRepresentation(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ID.test(value.representationId ?? "") &&
    SHA256.test(value.representationSha256 ?? "") &&
    STATUSES.has(value.status) &&
    Number.isSafeInteger(value.attachmentOrdinal) &&
    value.attachmentOrdinal >= 0 &&
    value.attachmentOrdinal < MAX_REPRESENTATIONS &&
    Number.isSafeInteger(value.declaredBytes) &&
    value.declaredBytes >= 0 &&
    DETAILS.has(value.declaredDetail) &&
    Object.keys(value).every((key) =>
      [
        "representationId",
        "representationSha256",
        "status",
        "attachmentOrdinal",
        "declaredBytes",
        "declaredDetail",
      ].includes(key)
    )
  );
}

function parsePlan(bytes) {
  const plan = parseJson(
    bytes,
    "DELIVERY_PLAN_INVALID",
    "Delivery receipt plan",
  );
  if (
    plan?.kind !== "CODEX_CHAT_DELIVERY_RECEIPT_PLAN_V2" ||
    plan.protocolVersion !== 2 ||
    !SHA256.test(plan.manifestSha256 ?? "") ||
    !Number.isSafeInteger(plan.expectedEventSequence) ||
    plan.expectedEventSequence < 1 ||
    !SHA256.test(plan.expectedEventHash ?? "") ||
    !validRouting(plan.routing) ||
    !ID.test(plan.runId ?? "") ||
    !SHA256.test(plan.contextSha256 ?? "") ||
    !boundedString(plan.conversationIdentity) ||
    !ID.test(plan.turnId ?? "") ||
    !ID.test(plan.transport ?? "") ||
    !validTransportLocator(plan.locator) ||
    !validObservedAt(plan.observedAt) ||
    !ID.test(plan.evidenceClass ?? "") ||
    !ID.test(plan.providerNamespace ?? "") ||
    !optionalProviderId(plan.providerMessageId) ||
    !optionalProviderId(plan.providerAttachmentId) ||
    !optionalSha256(plan.providerMessageFingerprint) ||
    !optionalSha256(plan.providerAttachmentFingerprint) ||
    !EVIDENCE_KINDS.has(plan.evidenceKind) ||
    !SHA256.test(plan.evidenceSha256 ?? "") ||
    !Number.isSafeInteger(plan.evidenceBytes) ||
    plan.evidenceBytes < 0 ||
    plan.evidenceBytes > MAX_EVIDENCE_BYTES ||
    !validDeliveryRepresentation(plan.representation) ||
    Object.keys(plan).some((key) =>
      ![
        "kind",
        "protocolVersion",
        "manifestSha256",
        "expectedEventSequence",
        "expectedEventHash",
        "routing",
        "runId",
        "contextSha256",
        "conversationIdentity",
        "turnId",
        "transport",
        "locator",
        "observedAt",
        "evidenceClass",
        "providerNamespace",
        "providerMessageId",
        "providerAttachmentId",
        "providerMessageFingerprint",
        "providerAttachmentFingerprint",
        "evidenceKind",
        "evidenceSha256",
        "evidenceBytes",
        "representation",
      ].includes(key)
    )
  ) {
    fail("DELIVERY_PLAN_INVALID", "Delivery receipt plan does not match v2.");
  }
  if (
    plan.providerMessageId === null &&
    plan.providerAttachmentId === null &&
    plan.providerMessageFingerprint === null &&
    plan.providerAttachmentFingerprint === null
  ) {
    fail(
      "DELIVERY_EVIDENCE_INSUFFICIENT",
      "Delivery evidence requires a provider identifier or fingerprint.",
    );
  }
  return plan;
}

function routeMatches(expected, actual) {
  return (
    expected.workspaceId === actual.workspaceId &&
    expected.coordinatorId === actual.coordinatorId &&
    expected.workUnitId === actual.workUnitId &&
    expected.agentId === actual.agentId
  );
}

function assertRunBinding(run, plan, runId) {
  if (!run.routing || run.outbound?.confirmed !== true) {
    fail(
      "DELIVERY_RUN_STATE_INVALID",
      "Delivery receipt requires a coordinated run with a confirmed outbound.",
    );
  }
  if (
    plan.expectedEventSequence !== run.eventCount ||
    plan.expectedEventHash !== run.lastEventHash
  ) {
    fail(
      "DELIVERY_STREAM_HEAD_STALE",
      "Delivery observation does not match the current run stream head.",
    );
  }
  if (plan.runId !== runId || run.runId !== runId) {
    fail("DELIVERY_RUN_MISMATCH", "Delivery run identity does not match.");
  }
  if (!routeMatches(run.outbound.routing, plan.routing)) {
    fail("DELIVERY_ROUTE_MISMATCH", "Delivery route does not match the active outbound.");
  }
  if (plan.contextSha256 !== run.contextSha256) {
    fail("DELIVERY_CONTEXT_MISMATCH", "Delivery context does not match the active run.");
  }
  if (plan.conversationIdentity !== run.outbound.conversationIdentity) {
    fail(
      "DELIVERY_CONVERSATION_MISMATCH",
      "Delivery conversation does not match the active outbound.",
    );
  }
  if (plan.turnId !== run.outbound.turnId) {
    fail("DELIVERY_TURN_MISMATCH", "Delivery turn does not match the active outbound.");
  }
  const confirmation = run.outbound.confirmationEvidence;
  if (
    !confirmation ||
    plan.transport !== confirmation.transportKind ||
    stable(plan.locator) !== stable(confirmation.locator)
  ) {
    fail(
      "DELIVERY_TRANSPORT_MISMATCH",
      "Delivery transport evidence does not match the confirmed outbound.",
    );
  }
  if (
    confirmation.providerMessageFingerprint &&
    plan.providerMessageFingerprint !== confirmation.providerMessageFingerprint
  ) {
    fail(
      "DELIVERY_PROVIDER_MISMATCH",
      "Delivery provider message fingerprint does not match confirmation.",
    );
  }
}

function bindRepresentation(manifest, plan, evidenceBytes) {
  if (stable(plan.routing) !== stable(manifest.routing)) {
    fail(
      "DELIVERY_ROUTE_MISMATCH",
      "Delivery receipt route does not match the context manifest.",
    );
  }
  const declaration = plan.representation;
  const representation = manifest.representations.find(
    (item) => item.representationId === declaration.representationId,
  );
  if (!representation) {
    fail(
      "DELIVERY_REPRESENTATION_MISSING",
      `Delivery representation is absent from the manifest: ${declaration.representationId}`,
    );
  }
  if (
    declaration.representationSha256 !== representation.sha256 ||
    declaration.declaredBytes !== representation.bytes
  ) {
    fail(
      "DELIVERY_REPRESENTATION_MISMATCH",
      `Delivery representation changed from the manifest: ${declaration.representationId}`,
    );
  }
  const evidenceSha256 = sha256(evidenceBytes);
  if (
    plan.evidenceSha256 !== evidenceSha256 ||
    plan.evidenceBytes !== evidenceBytes.byteLength
  ) {
    fail(
      "DELIVERY_EVIDENCE_MISMATCH",
      "Delivery evidence bytes do not match the observation plan.",
    );
  }
  if (
    plan.evidenceKind === "exact-payload" &&
    (
      evidenceSha256 !== representation.sha256 ||
      evidenceBytes.byteLength !== representation.bytes
    )
  ) {
    fail(
      "DELIVERY_EXACT_PAYLOAD_MISMATCH",
      "Exact-payload evidence does not match the context representation.",
    );
  }
  return {
    representationId: representation.representationId,
    representationSha256: representation.sha256,
    representationBytes: representation.bytes,
    modality: representation.modality,
    mediaType: representation.mediaType,
    fidelity: representation.fidelity,
    attachmentOrdinal: declaration.attachmentOrdinal,
    declaredBytes: declaration.declaredBytes,
    declaredDetail: declaration.declaredDetail,
    deliveryStatus: declaration.status,
    modelVisible: "unknown",
  };
}

function buildReceipt({ manifest, manifestSha256, plan, evidenceBytes }) {
  const representation = bindRepresentation(manifest, plan, evidenceBytes);
  const slotId = sha256(stable({
    routing: plan.routing,
    runId: plan.runId,
    conversationIdentity: plan.conversationIdentity,
    turnId: plan.turnId,
    attachmentOrdinal: representation.attachmentOrdinal,
  }));
  const body = {
    kind: "COLLAB_DELIVERY_RECEIPT_V2",
    protocolVersion: 2,
    slotId,
    planSha256: sha256(stable(plan)),
    manifestSha256,
    manifestPlanSha256: manifest.planSha256,
    runId: plan.runId,
    expectedEventSequence: plan.expectedEventSequence,
    expectedEventHash: plan.expectedEventHash,
    contextSha256: plan.contextSha256,
    routing: plan.routing,
    conversationIdentity: plan.conversationIdentity,
    turnId: plan.turnId,
    transport: plan.transport,
    locator: plan.locator,
    observedAt: plan.observedAt,
    evidenceClass: plan.evidenceClass,
    provider: {
      namespace: plan.providerNamespace,
      messageId: plan.providerMessageId,
      attachmentId: plan.providerAttachmentId,
      messageFingerprint: plan.providerMessageFingerprint,
      attachmentFingerprint: plan.providerAttachmentFingerprint,
    },
    evidence: {
      kind: plan.evidenceKind,
      sha256: plan.evidenceSha256,
      bytes: plan.evidenceBytes,
    },
    representation,
  };
  return {
    ...body,
    receiptId: sha256(stable(body)),
  };
}

async function scanReceiptInputs({
  manifestBytes,
  planBytes,
  evidenceBytes,
  serialized,
  scanner,
  testMode,
}) {
  const staging = await mkdtemp(path.join(os.tmpdir(), "codex-chat-delivery-scan-"));
  try {
    await Promise.all([
      writeFile(path.join(staging, "manifest.json"), manifestBytes, { mode: 0o600 }),
      writeFile(path.join(staging, "plan.json"), planBytes, { mode: 0o600 }),
      writeFile(path.join(staging, "evidence.bin"), evidenceBytes, { mode: 0o600 }),
      writeFile(path.join(staging, "receipt.json"), serialized, { mode: 0o600 }),
    ]);
    return await scanDirectory(staging, scanner, { testMode });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function prepareDeliveryDirectory(stateDir, runId) {
  const absoluteStateDir = path.resolve(stateDir);
  const stateInfo = await lstat(absoluteStateDir).catch(() => null);
  if (!stateInfo?.isDirectory() || stateInfo.isSymbolicLink()) {
    fail(
      "DELIVERY_STATE_DIR_INVALID",
      "Delivery state directory must be an existing real directory.",
    );
  }
  const paths = statePaths(absoluteStateDir, runId);
  const runInfo = await lstat(paths.directory).catch(() => null);
  if (!runInfo?.isDirectory() || runInfo.isSymbolicLink()) {
    fail("DELIVERY_RUN_STATE_INVALID", "Delivery run directory is invalid.");
  }
  const canonicalRun = await realpath(paths.directory);
  const directory = path.join(canonicalRun, "delivery-receipts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    fail(
      "DELIVERY_OUTPUT_PARENT_INVALID",
      "Delivery receipt directory must be a real directory.",
    );
  }
  const canonicalDirectory = await realpath(directory);
  const identity = await stat(canonicalDirectory);
  return {
    paths,
    directory: canonicalDirectory,
    parent: canonicalDirectory,
    parentIdentity: { dev: identity.dev, ino: identity.ino },
  };
}

async function readExistingBytes(filePath, label) {
  const info = await lstat(filePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return null;
  return readRealFile(filePath, label, MAX_RECEIPT_BYTES);
}

function parseSlot(bytes) {
  const slot = parseJson(bytes, "DELIVERY_SLOT_INVALID", "Delivery slot");
  if (
    slot?.kind !== "CODEX_CHAT_DELIVERY_SLOT_V2" ||
    slot.protocolVersion !== 2 ||
    !SHA256.test(slot.slotId ?? "") ||
    !SHA256.test(slot.receiptId ?? "") ||
    !SHA256.test(slot.receiptSha256 ?? "") ||
    Object.keys(slot).some((key) =>
      ![
        "kind",
        "protocolVersion",
        "slotId",
        "receiptId",
        "receiptSha256",
      ].includes(key)
    )
  ) {
    fail("DELIVERY_SLOT_INVALID", "Delivery slot is malformed.");
  }
  return slot;
}

async function assertDeliveryDirectoryIdentity(directoryInfo) {
  const current = await stat(directoryInfo.parent).catch(() => null);
  if (
    !current ||
    current.dev !== directoryInfo.parentIdentity.dev ||
    current.ino !== directoryInfo.parentIdentity.ino
  ) {
    fail(
      "DELIVERY_OUTPUT_PARENT_CHANGED",
      "Delivery receipt directory identity changed.",
    );
  }
}

async function createEvidenceFiles({
  directoryInfo,
  receipt,
  serialized,
  receiptSha256,
}) {
  await assertDeliveryDirectoryIdentity(directoryInfo);
  const receiptPath = path.join(
    directoryInfo.directory,
    `${receipt.receiptId}.json`,
  );
  const slotPath = path.join(
    directoryInfo.directory,
    `${receipt.slotId}.slot.json`,
  );
  const existingSlotBytes = await readExistingBytes(
    slotPath,
    "DELIVERY_SLOT",
  );
  if (existingSlotBytes) {
    const slot = parseSlot(existingSlotBytes);
    if (
      slot.slotId !== receipt.slotId ||
      slot.receiptId !== receipt.receiptId ||
      slot.receiptSha256 !== receiptSha256
    ) {
      fail(
        "DELIVERY_SLOT_CONFLICT",
        "Delivery slot already binds different evidence.",
      );
    }
    const existingReceipt = await readExistingBytes(
      receiptPath,
      "DELIVERY_RECEIPT",
    );
    if (!existingReceipt || sha256(existingReceipt) !== receiptSha256) {
      fail(
        "DELIVERY_RECEIPT_CONFLICT",
        "Delivery slot receipt is missing or changed.",
      );
    }
    await assertDeliveryDirectoryIdentity(directoryInfo);
    return { receiptPath, slotPath, idempotent: true };
  }

  const existingReceipt = await readExistingBytes(
    receiptPath,
    "DELIVERY_RECEIPT",
  );
  if (existingReceipt) {
    if (
      sha256(existingReceipt) !== receiptSha256 ||
      existingReceipt.toString("utf8") !== serialized
    ) {
      fail(
        "DELIVERY_RECEIPT_CONFLICT",
        "Delivery receipt ID already contains different bytes.",
      );
    }
  } else {
    await atomicWrite(receiptPath, serialized, directoryInfo).catch((error) => {
      if (error.code === "OUTPUT_EXISTS") {
        fail(
          "DELIVERY_RECEIPT_CONFLICT",
          "Delivery receipt appeared during creation.",
        );
      }
      if (error.code === "OUTPUT_PARENT_CHANGED") {
        fail(
          "DELIVERY_OUTPUT_PARENT_CHANGED",
          "Delivery receipt directory changed during creation.",
        );
      }
      throw error;
    });
  }

  const slotSerialized = `${stable({
    kind: "CODEX_CHAT_DELIVERY_SLOT_V2",
    protocolVersion: 2,
    slotId: receipt.slotId,
    receiptId: receipt.receiptId,
    receiptSha256,
  })}\n`;
  await atomicWrite(slotPath, slotSerialized, directoryInfo).catch((error) => {
    if (error.code === "OUTPUT_EXISTS") {
      fail(
        "DELIVERY_SLOT_CONFLICT",
        "Delivery slot appeared during creation.",
      );
    }
    if (error.code === "OUTPUT_PARENT_CHANGED") {
      fail(
        "DELIVERY_OUTPUT_PARENT_CHANGED",
        "Delivery receipt directory changed during creation.",
      );
    }
    throw error;
  });
  return { receiptPath, slotPath, idempotent: false };
}

async function loadDeliveryRun({ stateDir, runId }) {
  try {
    return await loadRun({ stateDir, runId });
  } catch {
    fail(
      "DELIVERY_RUN_STATE_INVALID",
      "Delivery receipt requires an existing durable run.",
    );
  }
}

export async function createDeliveryReceipt({
  stateDir,
  runId,
  manifestPath,
  planPath,
  evidencePath,
  scanner = "gitleaks",
  testMode = false,
  testHooks = null,
}) {
  const initialRun = await loadDeliveryRun({ stateDir, runId });
  const [manifestBytes, planBytes, evidenceBytes] = await Promise.all([
    readRealFile(
      manifestPath,
      "DELIVERY_MANIFEST",
      MAX_MANIFEST_BYTES,
    ),
    readRealFile(planPath, "DELIVERY_PLAN", MAX_PLAN_BYTES),
    readRealFile(evidencePath, "DELIVERY_EVIDENCE", MAX_EVIDENCE_BYTES),
  ]);
  const manifest = parseManifest(manifestBytes);
  const plan = parsePlan(planBytes);
  assertRunBinding(initialRun, plan, runId);
  const manifestSha256 = sha256(manifestBytes);
  if (plan.manifestSha256 !== manifestSha256) {
    fail(
      "DELIVERY_MANIFEST_DIGEST_MISMATCH",
      "Delivery manifest bytes do not match the plan digest.",
    );
  }
  const receipt = buildReceipt({
    manifest,
    manifestSha256,
    plan,
    evidenceBytes,
  });
  const serialized = `${stable(receipt)}\n`;
  if (Buffer.byteLength(serialized) > MAX_RECEIPT_BYTES) {
    fail(
      "DELIVERY_RECEIPT_TOO_LARGE",
      `Delivery receipt exceeds ${MAX_RECEIPT_BYTES} bytes.`,
    );
  }
  const receiptSha256 = sha256(serialized);
  const scan = await scanReceiptInputs({
    manifestBytes,
    planBytes,
    evidenceBytes,
    serialized,
    scanner,
    testMode,
  });
  await testHooks?.beforeCommit?.();
  const directoryInfo = await prepareDeliveryDirectory(stateDir, runId);
  const lockPath = path.join(
    directoryInfo.directory,
    ".locks",
    `${receipt.slotId}.lock`,
  );
  const result = await withOwnedFileLock({
    lockPath,
    busyCode: "DELIVERY_SLOT_BUSY",
    busyMessage: "Another writer holds the delivery slot.",
  }, async () =>
    withOwnedFileLock({
      lockPath: directoryInfo.paths.lock,
      busyCode: "DELIVERY_RUN_BUSY",
      busyMessage: "Another writer holds the delivery run.",
    }, async () => {
      const currentRun = await loadDeliveryRun({ stateDir, runId });
      assertRunBinding(currentRun, plan, runId);
      return createEvidenceFiles({
        directoryInfo,
        receipt,
        serialized,
        receiptSha256,
      });
    })
  );
  return {
    artifactPath: result.receiptPath,
    slotPath: result.slotPath,
    size: Buffer.byteLength(serialized),
    sha256: receiptSha256,
    receiptId: receipt.receiptId,
    slotId: receipt.slotId,
    manifestSha256,
    evidenceSha256: receipt.evidence.sha256,
    representationCount: 1,
    representations: [{
      representationId: receipt.representation.representationId,
      representationSha256: receipt.representation.representationSha256,
      status: receipt.representation.deliveryStatus,
      modelVisible: receipt.representation.modelVisible,
    }],
    scanner: scan,
    idempotent: result.idempotent,
  };
}
