import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fail } from "./errors.mjs";
import { LIMITS_TRANSPORT_MANIFEST_V1 } from "./limits.mjs";
import {
  atomicWrite,
  inspectOutput,
} from "./pack.mjs";
import {
  decodeProtocolArtifact,
  encodeProtocolArtifact,
} from "./protocol-codecs.mjs";
import { scanDirectory } from "./scanner.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const INPUT_KEYS = Object.freeze([
  "contextBytes",
  "expectedContextSha256",
  "taskEnvelopeBytes",
  "expectedTaskEnvelopeSha256",
  "transportKind",
  "uploadCapability",
]);
const {
  maxContextBytes: MAX_CONTEXT_BYTES,
  maxTaskEnvelopeInputBytes: MAX_TASK_ENVELOPE_INPUT_BYTES,
  maxTaskEnvelopeComposerBytes: MAX_TASK_ENVELOPE_COMPOSER_BYTES,
  maxInlineContextBytes: MAX_INLINE_CONTEXT_BYTES,
  maxInlineComposerBytes: MAX_INLINE_COMPOSER_BYTES,
  maxArtifactBytes: MAX_ARTIFACT_BYTES,
} = LIMITS_TRANSPORT_MANIFEST_V1;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function exactKeys(value, keys) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
}

function decodeText(bytes, code, label) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0") || text.includes("\r") || !text.endsWith("\n")) {
      fail(code, `${label} must be NUL-free UTF-8/LF ending in LF.`);
    }
    return text;
  } catch (error) {
    if (error?.code) throw error;
    fail(code, `${label} must be valid UTF-8.`);
  }
}

function parseContext(bytes) {
  try {
    decodeProtocolArtifact(bytes, { expectedKind: "COLLAB_CONTEXT_V1" });
    return Buffer.from(bytes).toString("utf8");
  } catch (error) {
    if (!error?.code?.startsWith("PROTOCOL_")) throw error;
    fail(
      "TRANSPORT_CONTEXT_INVALID",
      "Transport context must be a canonical COLLAB_CONTEXT_V1 artifact.",
    );
  }
}

function inlineComposerText(
  taskText,
  taskSha256,
  contextText,
  contextSha256,
  boundaryId,
) {
  return [
    `CODEX_CHAT_TASK_BEGIN id=${boundaryId} sha256=${taskSha256}\n`,
    taskText,
    `CODEX_CHAT_TASK_END id=${boundaryId}\n`,
    `CODEX_CHAT_CONTEXT_BEGIN id=${boundaryId} sha256=${contextSha256}\n`,
    contextText,
    `CODEX_CHAT_CONTEXT_END id=${boundaryId}\n`,
  ].join("");
}

function emptyComposer() {
  return {
    contextPlacement: "none",
    boundaryId: null,
    bytes: 0,
    sha256: null,
    text: null,
  };
}

export function buildTransportManifest(input) {
  if (
    !exactKeys(input, INPUT_KEYS) ||
    !Buffer.isBuffer(input.contextBytes) ||
    input.contextBytes.byteLength === 0 ||
    input.contextBytes.byteLength > MAX_CONTEXT_BYTES ||
    !Buffer.isBuffer(input.taskEnvelopeBytes) ||
    input.taskEnvelopeBytes.byteLength === 0 ||
    input.taskEnvelopeBytes.byteLength > MAX_TASK_ENVELOPE_INPUT_BYTES ||
    !SHA256.test(input.expectedContextSha256 ?? "") ||
    !SHA256.test(input.expectedTaskEnvelopeSha256 ?? "") ||
    !ID.test(input.transportKind ?? "") ||
    !["available", "unavailable", "unknown"].includes(
      input.uploadCapability,
    )
  ) {
    fail(
      "TRANSPORT_PLAN_INPUT_INVALID",
      "Transport planning input is malformed or contains unsupported fields.",
    );
  }

  const contextText = parseContext(input.contextBytes);
  const taskText = decodeText(
    input.taskEnvelopeBytes,
    "TRANSPORT_TASK_ENVELOPE_INVALID",
    "Task envelope",
  );
  const contextSha256 = sha256(input.contextBytes);
  const taskEnvelopeSha256 = sha256(input.taskEnvelopeBytes);
  if (contextSha256 !== input.expectedContextSha256) {
    fail(
      "TRANSPORT_CONTEXT_DIGEST_MISMATCH",
      "Transport context does not match its expected SHA-256.",
    );
  }
  if (taskEnvelopeSha256 !== input.expectedTaskEnvelopeSha256) {
    fail(
      "TRANSPORT_TASK_ENVELOPE_DIGEST_MISMATCH",
      "Task envelope does not match its expected SHA-256.",
    );
  }

  const boundaryId = sha256(Buffer.concat([
    input.taskEnvelopeBytes,
    input.contextBytes,
  ]));
  const inlineText = inlineComposerText(
    taskText,
    taskEnvelopeSha256,
    contextText,
    contextSha256,
    boundaryId,
  );
  const inlineBytes = Buffer.byteLength(inlineText);
  let strategy;
  let failureReason = null;
  let composer;
  let attachment;
  if (input.taskEnvelopeBytes.byteLength > MAX_TASK_ENVELOPE_COMPOSER_BYTES) {
    strategy = "stop";
    failureReason = "task_envelope_too_large";
    composer = emptyComposer();
    attachment = { required: false, ordinal: null, sha256: null, bytes: null };
  } else if (
    input.contextBytes.byteLength <= MAX_INLINE_CONTEXT_BYTES &&
    inlineBytes <= MAX_INLINE_COMPOSER_BYTES
  ) {
    strategy = "inline-context";
    composer = {
      contextPlacement: "inline",
      boundaryId,
      bytes: inlineBytes,
      sha256: sha256(inlineText),
      text: inlineText,
    };
    attachment = { required: false, ordinal: null, sha256: null, bytes: null };
  } else if (input.uploadCapability === "available") {
    strategy = "attachment-context";
    composer = {
      contextPlacement: "attachment",
      boundaryId: null,
      bytes: input.taskEnvelopeBytes.byteLength,
      sha256: taskEnvelopeSha256,
      text: taskText,
    };
    attachment = {
      required: true,
      ordinal: 0,
      sha256: contextSha256,
      bytes: input.contextBytes.byteLength,
    };
  } else {
    strategy = "stop";
    failureReason = `upload_capability_${input.uploadCapability}`;
    composer = emptyComposer();
    attachment = { required: false, ordinal: null, sha256: null, bytes: null };
  }

  return {
    kind: "CODEX_CHAT_TRANSPORT_MANIFEST_V1",
    protocolVersion: 1,
    transportKind: input.transportKind,
    uploadCapability: input.uploadCapability,
    strategy,
    failureReason,
    reservationEligible: strategy !== "stop",
    context: {
      kind: "COLLAB_CONTEXT_V1",
      bytes: input.contextBytes.byteLength,
      sha256: contextSha256,
    },
    taskEnvelope: {
      bytes: input.taskEnvelopeBytes.byteLength,
      sha256: taskEnvelopeSha256,
    },
    composer,
    attachment,
    thresholds: {
      maxTaskEnvelopeComposerBytes: MAX_TASK_ENVELOPE_COMPOSER_BYTES,
      maxInlineContextBytes: MAX_INLINE_CONTEXT_BYTES,
      maxInlineComposerBytes: MAX_INLINE_COMPOSER_BYTES,
    },
    modelVisible: "unknown",
    actionAuthorized: false,
    resendAuthorized: false,
  };
}

export async function readBoundedTransportFile(filePath, label, maxBytes) {
  const absolute = path.resolve(filePath);
  const before = await lstat(absolute).catch(() => null);
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.size === 0 ||
    before.size > maxBytes
  ) {
    fail(
      `${label}_INVALID`,
      `${label.replaceAll("_", " ")} must be a bounded real file.`,
    );
  }
  let handle;
  try {
    handle = await open(
      absolute,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch {
    fail(`${label}_INVALID`, `${label.replaceAll("_", " ")} changed.`);
  }
  try {
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const after = await lstat(absolute).catch(() => null);
    if (
      !opened.isFile() ||
      opened.size > maxBytes ||
      bytes.byteLength !== opened.size ||
      !after ||
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      fail(`${label}_CHANGED`, `${label.replaceAll("_", " ")} changed.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function createTransportManifest({
  root,
  contextPath,
  expectedContextSha256,
  taskEnvelopePath,
  expectedTaskEnvelopeSha256,
  transportKind,
  uploadCapability,
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
  const [contextBytes, taskEnvelopeBytes] = await Promise.all([
    readBoundedTransportFile(contextPath, "TRANSPORT_CONTEXT", MAX_CONTEXT_BYTES),
    readBoundedTransportFile(
      taskEnvelopePath,
      "TRANSPORT_TASK_ENVELOPE",
      MAX_TASK_ENVELOPE_INPUT_BYTES,
    ),
  ]);
  const manifest = buildTransportManifest({
    contextBytes,
    expectedContextSha256,
    taskEnvelopeBytes,
    expectedTaskEnvelopeSha256,
    transportKind,
    uploadCapability,
  });
  const serialized = encodeProtocolArtifact(manifest);
  if (serialized.byteLength > MAX_ARTIFACT_BYTES) {
    fail(
      "TRANSPORT_MANIFEST_TOO_LARGE",
      `Transport manifest exceeds ${MAX_ARTIFACT_BYTES} bytes.`,
    );
  }

  const staging = await mkdtemp(
    path.join(os.tmpdir(), "codex-chat-transport-scan-"),
  );
  try {
    await Promise.all([
      writeFile(path.join(staging, "context.json"), contextBytes, {
        mode: 0o600,
      }),
      writeFile(path.join(staging, "task-envelope.txt"), taskEnvelopeBytes, {
        mode: 0o600,
      }),
      writeFile(path.join(staging, "transport-manifest.json"), serialized, {
        mode: 0o600,
      }),
    ]);
    var scan = await scanDirectory(staging, scanner, { testMode });
    await atomicWrite(outputInfo.target, serialized, outputInfo);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  return {
    artifactPath: outputInfo.target,
    size: serialized.byteLength,
    sha256: sha256(serialized),
    strategy: manifest.strategy,
    failureReason: manifest.failureReason,
    reservationEligible: manifest.reservationEligible,
    composerSha256: manifest.composer.sha256,
    contextSha256: manifest.context.sha256,
    taskEnvelopeSha256: manifest.taskEnvelope.sha256,
    modelVisible: manifest.modelVisible,
    actionAuthorized: manifest.actionAuthorized,
    resendAuthorized: manifest.resendAuthorized,
    scanner: scan,
  };
}
