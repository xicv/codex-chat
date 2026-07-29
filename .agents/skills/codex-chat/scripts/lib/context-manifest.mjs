import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fail } from "./errors.mjs";
import { LIMITS_V2 } from "./limits.mjs";
import {
  atomicWrite,
  inspectOutput,
  isSensitivePath,
  readSelectedFile,
} from "./pack.mjs";
import { validateIncludes, validateRelativePath } from "./preflight.mjs";
import { scanDirectory } from "./scanner.mjs";

const {
  maxPlanBytes: MAX_PLAN_BYTES,
  maxRepresentations: MAX_REPRESENTATIONS,
  maxRepresentationBytes: MAX_REPRESENTATION_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxArtifactBytes: MAX_ARTIFACT_BYTES,
} = LIMITS_V2.manifest;
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
const FIDELITY = new Set(["exact", "lossless", "lossy"]);
const TEXT_MODALITIES = new Set(["code", "text", "data"]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function arrayOfStrings(value, maxItems = 64) {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) =>
      typeof item === "string" &&
      item.length > 0 &&
      Buffer.byteLength(item) <= 4096
    )
  );
}

function validateRouting(value) {
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

function validateLocator(value) {
  return (
    value === null ||
    (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      ID.test(value.space ?? "") &&
      typeof value.value === "string" &&
      value.value.length > 0 &&
      Buffer.byteLength(value.value) <= 4096 &&
      Object.keys(value).every((key) => ["space", "value"].includes(key))
    )
  );
}

function validateTransform(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.tool === "string" &&
    value.tool.length > 0 &&
    typeof value.version === "string" &&
    value.version.length > 0 &&
    value.parameters &&
    typeof value.parameters === "object" &&
    !Array.isArray(value.parameters) &&
    typeof value.coverage === "string" &&
    value.coverage.length > 0 &&
    typeof value.truncated === "boolean" &&
    Object.keys(value).every((key) =>
      ["tool", "version", "parameters", "coverage", "truncated"].includes(key)
    )
  );
}

function parsePlan(contents) {
  if (Buffer.byteLength(contents) > MAX_PLAN_BYTES) {
    fail("MANIFEST_PLAN_TOO_LARGE", `Manifest plan exceeds ${MAX_PLAN_BYTES} bytes.`);
  }
  let plan;
  try {
    plan = JSON.parse(contents);
  } catch {
    fail("MANIFEST_PLAN_INVALID", "Context manifest plan is not valid JSON.");
  }
  if (
    plan?.kind !== "CODEX_CHAT_MANIFEST_PLAN_V2" ||
    plan.protocolVersion !== 2 ||
    !validateRouting(plan.routing) ||
    !ID.test(plan.checkpointNamespace ?? "") ||
    !plan.checkpoint ||
    typeof plan.checkpoint !== "object" ||
    typeof plan.checkpoint.goal !== "string" ||
    plan.checkpoint.goal.length === 0 ||
    !arrayOfStrings(plan.checkpoint.invariants) ||
    !arrayOfStrings(plan.checkpoint.decisions) ||
    !arrayOfStrings(plan.checkpoint.unresolved) ||
    !["unverified", "partial", "verified"].includes(
      plan.checkpoint.verificationStatus,
    ) ||
    Object.keys(plan.checkpoint).some((key) =>
      ![
        "goal",
        "invariants",
        "decisions",
        "unresolved",
        "verificationStatus",
      ].includes(key)
    ) ||
    !Array.isArray(plan.representations) ||
    plan.representations.length === 0 ||
    plan.representations.length > MAX_REPRESENTATIONS ||
    Object.keys(plan).some((key) =>
      ![
        "kind",
        "protocolVersion",
        "routing",
        "checkpointNamespace",
        "parent",
        "checkpoint",
        "representations",
      ].includes(key)
    )
  ) {
    fail("MANIFEST_PLAN_INVALID", "Context manifest plan does not match v2.");
  }
  if (
    plan.parent !== null &&
    (
      !plan.parent ||
      typeof plan.parent !== "object" ||
      !SHA256.test(plan.parent.contextSha256 ?? "") ||
      !ID.test(plan.parent.turnId ?? "") ||
      Object.keys(plan.parent).some((key) =>
        !["contextSha256", "turnId"].includes(key)
      )
    )
  ) {
    fail("MANIFEST_PARENT_INVALID", "Manifest parent binding is invalid.");
  }
  const ids = new Set();
  for (const representation of plan.representations) {
    const derived = representation.sourceRepresentationId !== null;
    if (
      !representation ||
      typeof representation !== "object" ||
      !ID.test(representation.representationId ?? "") ||
      ids.has(representation.representationId) ||
      typeof representation.path !== "string" ||
      representation.path.length === 0 ||
      !MODALITIES.has(representation.modality) ||
      !MEDIA_TYPE.test(representation.mediaType ?? "") ||
      typeof representation.role !== "string" ||
      representation.role.length === 0 ||
      typeof representation.purpose !== "string" ||
      representation.purpose.length === 0 ||
      !FIDELITY.has(representation.fidelity) ||
      !validateLocator(representation.locator) ||
      (
        representation.expectedSha256 !== undefined &&
        !SHA256.test(representation.expectedSha256)
      ) ||
      (
        derived
          ? (
              !ID.test(representation.sourceRepresentationId ?? "") ||
              representation.fidelity === "exact" ||
              !validateTransform(representation.transform)
            )
          : (
              representation.fidelity !== "exact" ||
              representation.transform !== null
            )
      ) ||
      Object.keys(representation).some((key) =>
        ![
          "representationId",
          "path",
          "modality",
          "mediaType",
          "role",
          "purpose",
          "fidelity",
          "sourceRepresentationId",
          "locator",
          "transform",
          "expectedSha256",
        ].includes(key)
      )
    ) {
      fail(
        "MANIFEST_REPRESENTATION_INVALID",
        `Invalid context representation: ${representation?.representationId ?? "unknown"}`,
      );
    }
    ids.add(representation.representationId);
  }
  const byId = new Map(plan.representations.map((item) => [
    item.representationId,
    item,
  ]));
  for (const representation of plan.representations) {
    if (
      representation.sourceRepresentationId !== null &&
      !byId.has(representation.sourceRepresentationId)
    ) {
      fail(
        "MANIFEST_SOURCE_MISSING",
        `Derived representation source is missing: ${representation.representationId}`,
      );
    }
    const visited = new Set();
    let current = representation;
    while (current.sourceRepresentationId !== null) {
      if (visited.has(current.representationId)) {
        fail("MANIFEST_SOURCE_CYCLE", "Representation provenance contains a cycle.");
      }
      visited.add(current.representationId);
      current = byId.get(current.sourceRepresentationId);
    }
  }
  return plan;
}

function textProperties(bytes, relativePath) {
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("MANIFEST_TEXT_INVALID", `Text representation is not valid UTF-8: ${relativePath}`);
  }
  if (content.includes("\0")) {
    fail("MANIFEST_TEXT_INVALID", `Text representation contains NUL bytes: ${relativePath}`);
  }
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const bareLf = (content.replaceAll("\r\n", "").match(/\n/g) ?? []).length;
  const bareCr = (content.replaceAll("\r\n", "").match(/\r/g) ?? []).length;
  const lineEndings =
    crlf > 0 && (bareLf > 0 || bareCr > 0)
      ? "mixed"
      : crlf > 0
        ? "crlf"
        : bareLf > 0
          ? "lf"
          : bareCr > 0
            ? "cr"
            : "none";
  return {
    charset: "utf-8",
    bom: bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
    lineEndings,
  };
}

export async function createContextManifest({
  root,
  planPath,
  output,
  scanner = "gitleaks",
  testMode = false,
}) {
  const absoluteRoot = path.resolve(root);
  const rootInfo = await lstat(absoluteRoot).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    fail("ROOT_INVALID", `Root must be a real directory: ${absoluteRoot}`);
  }
  const canonicalRoot = await realpath(absoluteRoot);
  const outputInfo = await inspectOutput(absoluteRoot, canonicalRoot, output);
  const absolutePlan = path.resolve(planPath);
  const planInfo = await lstat(absolutePlan).catch(() => null);
  if (!planInfo?.isFile() || planInfo.isSymbolicLink()) {
    fail("MANIFEST_PLAN_INVALID", "Manifest plan must be a real file.");
  }
  const planContents = await readFile(absolutePlan, "utf8");
  const plan = parsePlan(planContents);
  const representationPaths = plan.representations.map(
    ({ path: relativePath }) => validateRelativePath(relativePath),
  );
  await validateIncludes(
    canonicalRoot,
    representationPaths,
    { filesOnly: true },
  );
  const normalizedByInput = new Map(
    plan.representations.map((representation, index) => [
      representation.representationId,
      representationPaths[index],
    ]),
  );
  const records = [];
  const bytesById = new Map();
  let totalBytes = 0;
  for (const representation of plan.representations) {
    const relativePath = normalizedByInput.get(representation.representationId);
    if (isSensitivePath(relativePath)) {
      fail("SENSITIVE_PATH", `Sensitive path is not eligible for collaboration: ${relativePath}`);
    }
    const bytes = await readSelectedFile(canonicalRoot, relativePath);
    if (bytes.byteLength > MAX_REPRESENTATION_BYTES) {
      fail(
        "MANIFEST_REPRESENTATION_TOO_LARGE",
        `Representation exceeds ${MAX_REPRESENTATION_BYTES} bytes: ${relativePath}`,
      );
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      fail("MANIFEST_PAYLOAD_TOO_LARGE", `Representations exceed ${MAX_TOTAL_BYTES} bytes.`);
    }
    const representationSha256 = sha256(bytes);
    if (
      representation.expectedSha256 &&
      representation.expectedSha256 !== representationSha256
    ) {
      fail(
        "MANIFEST_EXPECTED_DIGEST_MISMATCH",
        `Representation changed from its expected digest: ${relativePath}`,
      );
    }
    bytesById.set(representation.representationId, bytes);
    records.push({
      representationId: representation.representationId,
      path: relativePath,
      modality: representation.modality,
      mediaType: representation.mediaType,
      role: representation.role,
      purpose: representation.purpose,
      bytes: bytes.byteLength,
      sha256: representationSha256,
      fidelity: representation.fidelity,
      sourceRepresentationId: representation.sourceRepresentationId,
      sourceSha256: null,
      locator: representation.locator,
      transform: representation.transform,
      text:
        TEXT_MODALITIES.has(representation.modality)
          ? textProperties(bytes, relativePath)
          : null,
      delivery: {
        status: "staged",
        modelVisible: "unknown",
        transport: null,
        conversationIdentity: null,
        turnId: null,
        providerAttachmentId: null,
        providerFingerprint: null,
      },
    });
  }
  const recordsById = new Map(records.map((record) => [
    record.representationId,
    record,
  ]));
  for (const record of records) {
    if (record.sourceRepresentationId !== null) {
      record.sourceSha256 =
        recordsById.get(record.sourceRepresentationId).sha256;
    }
  }
  const artifact = {
    kind: "COLLAB_CONTEXT_MANIFEST_V2",
    protocolVersion: 2,
    rootLabel: path.basename(canonicalRoot),
    planSha256: sha256(planContents),
    routing: plan.routing,
    checkpointNamespace: plan.checkpointNamespace,
    parent: plan.parent,
    checkpoint: plan.checkpoint,
    representations: records,
  };
  const serialized = `${JSON.stringify(artifact)}\n`;
  if (Buffer.byteLength(serialized) > MAX_ARTIFACT_BYTES) {
    fail("MANIFEST_ARTIFACT_TOO_LARGE", `Manifest exceeds ${MAX_ARTIFACT_BYTES} bytes.`);
  }
  const staging = await mkdtemp(path.join(os.tmpdir(), "codex-chat-manifest-scan-"));
  try {
    for (const [index, record] of records.entries()) {
      await writeFile(
        path.join(staging, `${String(index).padStart(4, "0")}.payload`),
        bytesById.get(record.representationId),
        { mode: 0o600 },
      );
    }
    await writeFile(path.join(staging, "manifest.json"), serialized, { mode: 0o600 });
    var scan = await scanDirectory(staging, scanner, { testMode });
    await atomicWrite(outputInfo.target, serialized, outputInfo);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return {
    artifactPath: outputInfo.target,
    size: Buffer.byteLength(serialized),
    sha256: sha256(serialized),
    totalBytes,
    representationCount: records.length,
    representations: records.map((record) => ({
      representationId: record.representationId,
      path: record.path,
      bytes: record.bytes,
      sha256: record.sha256,
      modality: record.modality,
      fidelity: record.fidelity,
      modelVisible: record.delivery.modelVisible,
    })),
    scanner: scan,
  };
}
