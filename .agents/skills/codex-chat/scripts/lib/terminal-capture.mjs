import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fail } from "./errors.mjs";
import { withOwnedFileLock } from "./file-lock.mjs";
import { parseResultEnvelope } from "./import.mjs";
import { LIMITS_V1 } from "./limits.mjs";
import { atomicWrite } from "./pack.mjs";
import { scanDirectory } from "./scanner.mjs";
import { loadRun, statePaths } from "./state.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const BEGIN = "CODEX_CHAT_RESULT_BEGIN";
const END = "CODEX_CHAT_RESULT_END";
const {
  maxCaptureBytes: MAX_CAPTURE_BYTES,
  maxReceiptBytes: MAX_RECEIPT_BYTES,
} = LIMITS_V1.terminalCapture;
const RECEIPT_KEYS = new Set([
  "kind",
  "protocolVersion",
  "slotId",
  "bindings",
  "capture",
  "resultEnvelope",
  "resultValidation",
  "receiptId",
]);
const BINDING_KEYS = new Set([
  "runId",
  "turnId",
  "contextSha256",
  "taskEnvelopeSha256",
  "outboundBindingVersion",
  "routing",
  "providerNamespace",
  "conversationIdentity",
  "terminalMarker",
  "providerMessageFingerprint",
]);
const CAPTURE_KEYS = new Set([
  "objectPath",
  "sha256",
  "bytes",
  "state",
  "truncated",
]);
const RESULT_KEYS = new Set(["objectPath", "sha256", "bytes"]);
const RESULT_VALIDATION_KEYS = new Set(["status", "errorCode"]);
const SLOT_KEYS = new Set([
  "kind",
  "protocolVersion",
  "slotId",
  "receiptId",
  "receiptSha256",
]);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stable(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function decodeUtf8(bytes, label) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0") || text.includes("\r")) {
      fail(
        "TERMINAL_CAPTURE_TEXT_INVALID",
        `${label} must be NUL-free UTF-8 with LF line endings.`,
      );
    }
    return text;
  } catch (error) {
    if (error?.code) throw error;
    fail("TERMINAL_CAPTURE_TEXT_INVALID", `${label} must be valid UTF-8.`);
  }
}

async function readRealFile(filePath, label, maxBytes) {
  const absolute = path.resolve(filePath);
  const info = await lstat(absolute).catch((error) => {
    if (error.code === "ENOENT") {
      fail(`${label}_MISSING`, `${label} does not exist.`);
    }
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    fail(
      `${label}_INVALID`,
      `${label} must be a real file no larger than ${maxBytes} bytes.`,
    );
  }
  let handle;
  try {
    handle = await open(
      absolute,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes(error.code)) {
      fail(`${label}_CHANGED`, `${label} changed before it could be opened.`);
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) {
      fail(`${label}_INVALID`, `${label} is not an eligible regular file.`);
    }
    const bytes = await handle.readFile();
    const after = await lstat(absolute).catch(() => null);
    if (
      !after ||
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size
    ) {
      fail(`${label}_CHANGED`, `${label} changed while it was read.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function extractResultBytes(captureText, expectedTerminalMarker) {
  const beginToken = `${BEGIN}\n`;
  const endToken = `\n${END}\n`;
  const begin = captureText.indexOf(beginToken);
  const end = captureText.indexOf(endToken);
  if (
    begin < 0 ||
    end < begin + beginToken.length ||
    captureText.indexOf(beginToken, begin + beginToken.length) !== -1 ||
    captureText.indexOf(endToken, end + endToken.length) !== -1
  ) {
    fail(
      "TERMINAL_CAPTURE_BOUNDARY_INVALID",
      "Terminal capture must contain exactly one ordered result boundary pair.",
    );
  }
  const suffix = captureText.slice(end + endToken.length);
  if (suffix !== expectedTerminalMarker && suffix !== `${expectedTerminalMarker}\n`) {
    fail(
      "TERMINAL_CAPTURE_MARKER_INVALID",
      "Terminal capture must end with the expected terminal marker.",
    );
  }
  return Buffer.from(`${captureText.slice(begin + beginToken.length, end)}\n`);
}

function routingMatches(expected, actual) {
  if (expected === null && actual === null) return true;
  return (
    expected &&
    actual &&
    ["workspaceId", "coordinatorId", "workUnitId", "agentId"].every(
      (key) => expected[key] === actual[key],
    )
  );
}

function slotIdForBindings(bindings) {
  return sha256(stable({
    routing: bindings.routing,
    runId: bindings.runId,
    turnId: bindings.turnId,
    conversationIdentity: bindings.conversationIdentity,
  }));
}

function assertRunEligible(run, runId) {
  if (
    run.runId !== runId ||
    run.outbound?.outboundBindingVersion !== 2 ||
    !["send_confirmed", "response_pending_unknown", "human_required"].includes(run.phase)
  ) {
    fail(
      "TERMINAL_CAPTURE_RUN_INVALID",
      "Terminal capture receipts require an active hardened outbound turn.",
    );
  }
}

function assertEnvelopeBinding(envelope, run) {
  if (
    envelope.runId !== run.runId ||
    envelope.turnId !== run.outbound.turnId ||
    envelope.contextSha256 !== run.outbound.contextSha256
  ) {
    fail(
      "TERMINAL_CAPTURE_RESULT_BINDING_MISMATCH",
      "Result envelope does not bind the active run, turn, and context.",
    );
  }
}

async function prepareDirectory(stateDir, runId) {
  const paths = statePaths(stateDir, runId);
  const runInfo = await lstat(paths.directory).catch(() => null);
  if (!runInfo?.isDirectory() || runInfo.isSymbolicLink()) {
    fail("TERMINAL_CAPTURE_RUN_INVALID", "Run state directory is invalid.");
  }
  const runDirectory = await realpath(paths.directory);
  const root = path.join(runDirectory, "terminal-captures");
  const directories = [
    root,
    path.join(root, "objects"),
    path.join(root, "receipts"),
    path.join(root, "slots"),
    path.join(root, ".locks"),
  ];
  const parentIdentities = new Map();
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail(
        "TERMINAL_CAPTURE_OUTPUT_INVALID",
        "Terminal capture evidence directories must be real directories.",
      );
    }
    const canonical = await realpath(directory);
    const identity = await stat(canonical);
    parentIdentities.set(canonical, { dev: identity.dev, ino: identity.ino });
  }
  const canonicalRoot = await realpath(root);
  const identity = await stat(canonicalRoot);
  return {
    root: canonicalRoot,
    parent: canonicalRoot,
    parentIdentity: { dev: identity.dev, ino: identity.ino },
    parentIdentities,
  };
}

function buildReceipt({
  run,
  captureBytes,
  resultBytes,
  resultValidation,
}) {
  const bindings = {
    runId: run.runId,
    turnId: run.outbound.turnId,
    contextSha256: run.outbound.contextSha256,
    taskEnvelopeSha256: run.outbound.taskEnvelopeSha256,
    outboundBindingVersion: 2,
    routing: run.outbound.routing,
    providerNamespace: run.outbound.providerNamespace,
    conversationIdentity: run.outbound.conversationIdentity,
    terminalMarker: run.outbound.expectedTerminalMarker,
    providerMessageFingerprint:
      run.outbound.confirmationEvidence?.providerMessageFingerprint ?? null,
  };
  const captureSha256 = sha256(captureBytes);
  const resultEnvelopeSha256 = sha256(resultBytes);
  const slotId = slotIdForBindings(bindings);
  const body = {
    kind: "CODEX_CHAT_TERMINAL_CAPTURE_RECEIPT_V1",
    protocolVersion: 1,
    slotId,
    bindings,
    capture: {
      objectPath: `objects/${captureSha256}.response.txt`,
      sha256: captureSha256,
      bytes: captureBytes.byteLength,
      state: "terminal",
      truncated: false,
    },
    resultEnvelope: {
      objectPath: `objects/${resultEnvelopeSha256}.result.json`,
      sha256: resultEnvelopeSha256,
      bytes: resultBytes.byteLength,
    },
    ...(resultValidation.status === "rejected"
      ? { resultValidation }
      : {}),
  };
  return { ...body, receiptId: sha256(stable(body)) };
}

async function scanInputs({
  captureBytes,
  resultBytes,
  serialized,
  scanner,
  testMode,
}) {
  const staging = await mkdtemp(path.join(os.tmpdir(), "codex-chat-terminal-scan-"));
  try {
    await Promise.all([
      writeFile(path.join(staging, "capture.txt"), captureBytes, { mode: 0o600 }),
      writeFile(path.join(staging, "result.json"), resultBytes, { mode: 0o600 }),
      writeFile(path.join(staging, "receipt.json"), serialized, { mode: 0o600 }),
    ]);
    return await scanDirectory(staging, scanner, { testMode });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function readExisting(filePath, maxBytes, code) {
  const info = await lstat(filePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    fail(code, "Existing terminal capture evidence is invalid.");
  }
  return readFile(filePath);
}

async function writeOrVerify(filePath, bytes, directoryInfo, maxBytes, code) {
  const existing = await readExisting(filePath, maxBytes, code);
  if (existing) {
    if (!existing.equals(bytes)) {
      fail(code, "Digest-addressed terminal capture evidence contains different bytes.");
    }
    return false;
  }
  const parent = path.dirname(filePath);
  const parentIdentity = directoryInfo.parentIdentities.get(parent);
  if (!parentIdentity) {
    fail(code, "Terminal capture target parent is not an approved directory.");
  }
  await atomicWrite(filePath, bytes, { parent, parentIdentity }).catch((error) => {
    if (error.code === "OUTPUT_EXISTS") {
      fail(code, "Terminal capture evidence appeared during creation.");
    }
    throw error;
  });
  return true;
}

async function assertExistingExact(filePath, bytes, maxBytes, code) {
  const existing = await readExisting(filePath, maxBytes, code);
  if (!existing || !existing.equals(bytes)) {
    fail(code, "Authoritative terminal capture evidence is missing or changed.");
  }
}

function parseReceipt(bytes) {
  if (bytes.byteLength > MAX_RECEIPT_BYTES) {
    fail("TERMINAL_CAPTURE_RECEIPT_INVALID", "Terminal capture receipt is too large.");
  }
  let receipt;
  try {
    receipt = JSON.parse(bytes);
  } catch {
    fail("TERMINAL_CAPTURE_RECEIPT_INVALID", "Terminal capture receipt is not valid JSON.");
  }
  const { receiptId, ...body } = receipt ?? {};
  const bindings = receipt?.bindings;
  const capture = receipt?.capture;
  const resultEnvelope = receipt?.resultEnvelope;
  const resultValidation = receipt?.resultValidation ?? {
    status: "accepted",
    errorCode: null,
  };
  if (
    receipt?.kind !== "CODEX_CHAT_TERMINAL_CAPTURE_RECEIPT_V1" ||
    receipt.protocolVersion !== 1 ||
    Object.keys(receipt).some((key) => !RECEIPT_KEYS.has(key)) ||
    !SHA256.test(receiptId ?? "") ||
    sha256(stable(body)) !== receiptId ||
    !SHA256.test(receipt.slotId ?? "") ||
    !bindings ||
    typeof bindings !== "object" ||
    Array.isArray(bindings) ||
    Object.keys(bindings).some((key) => !BINDING_KEYS.has(key)) ||
    typeof bindings.runId !== "string" ||
    typeof bindings.turnId !== "string" ||
    !SHA256.test(bindings.contextSha256 ?? "") ||
    !SHA256.test(bindings.taskEnvelopeSha256 ?? "") ||
    bindings.outboundBindingVersion !== 2 ||
    typeof bindings.providerNamespace !== "string" ||
    typeof bindings.conversationIdentity !== "string" ||
    typeof bindings.terminalMarker !== "string" ||
    (
      bindings.providerMessageFingerprint !== null &&
      !SHA256.test(bindings.providerMessageFingerprint ?? "")
    ) ||
    receipt.slotId !== slotIdForBindings(bindings) ||
    !capture ||
    typeof capture !== "object" ||
    Array.isArray(capture) ||
    Object.keys(capture).some((key) => !CAPTURE_KEYS.has(key)) ||
    typeof capture.objectPath !== "string" ||
    !SHA256.test(capture.sha256 ?? "") ||
    !Number.isInteger(capture.bytes) ||
    capture.bytes < 1 ||
    capture.bytes > MAX_CAPTURE_BYTES ||
    capture.state !== "terminal" ||
    capture.truncated !== false ||
    !resultEnvelope ||
    typeof resultEnvelope !== "object" ||
    Array.isArray(resultEnvelope) ||
    Object.keys(resultEnvelope).some((key) => !RESULT_KEYS.has(key)) ||
    typeof resultEnvelope.objectPath !== "string" ||
    !SHA256.test(resultEnvelope.sha256 ?? "") ||
    !Number.isInteger(resultEnvelope.bytes) ||
    resultEnvelope.bytes < 1 ||
    resultEnvelope.bytes > LIMITS_V1.result.maxResultBytes ||
    !resultValidation ||
    typeof resultValidation !== "object" ||
    Array.isArray(resultValidation) ||
    (
      receipt.resultValidation !== undefined &&
      (
        Object.keys(resultValidation).some(
          (key) => !RESULT_VALIDATION_KEYS.has(key),
        ) ||
        resultValidation.status !== "rejected" ||
        !/^RESULT_[A-Z0-9_]+$/.test(resultValidation.errorCode ?? "")
      )
    )
  ) {
    fail("TERMINAL_CAPTURE_RECEIPT_INVALID", "Terminal capture receipt is malformed.");
  }
  return receipt;
}

function parseSlot(bytes, receipt, receiptSha256) {
  if (bytes.byteLength > MAX_RECEIPT_BYTES) {
    fail("TERMINAL_CAPTURE_SLOT_INVALID", "Terminal capture slot is too large.");
  }
  let slot;
  try {
    slot = JSON.parse(bytes);
  } catch {
    fail("TERMINAL_CAPTURE_SLOT_INVALID", "Terminal capture slot is not valid JSON.");
  }
  if (
    slot?.kind !== "CODEX_CHAT_TERMINAL_CAPTURE_SLOT_V1" ||
    slot.protocolVersion !== 1 ||
    Object.keys(slot).some((key) => !SLOT_KEYS.has(key)) ||
    slot.slotId !== receipt.slotId ||
    slot.receiptId !== receipt.receiptId ||
    slot.receiptSha256 !== receiptSha256
  ) {
    fail(
      "TERMINAL_CAPTURE_SLOT_MISMATCH",
      "Authoritative terminal capture slot does not match the receipt.",
    );
  }
  return slot;
}

function eventDataFromReceipt(receipt, receiptPath, receiptSha256) {
  const rejected = receipt.resultValidation?.status === "rejected";
  return {
    turnId: receipt.bindings.turnId,
    terminalMarker: receipt.bindings.terminalMarker,
    responseSha256: receipt.capture.sha256,
    resultEnvelopeSha256: receipt.resultEnvelope.sha256,
    conversationIdentity: receipt.bindings.conversationIdentity,
    routing: receipt.bindings.routing,
    captureState: receipt.capture.state,
    truncated: receipt.capture.truncated,
    captureSha256: receipt.capture.sha256,
    providerMessageFingerprint: receipt.bindings.providerMessageFingerprint,
    captureReceiptPath: receiptPath,
    captureReceiptSha256: receiptSha256,
    ...(rejected
      ? {
          resultStatus: "rejected",
          rejectionCode: receipt.resultValidation.errorCode,
        }
      : {}),
  };
}

function activeTerminalEventData(current) {
  const binding = current.collaboration?.responseBinding;
  if (
    !binding ||
    !path.isAbsolute(binding.captureReceiptPath ?? "") ||
    !SHA256.test(binding.captureReceiptSha256 ?? "")
  ) {
    fail(
      "TERMINAL_CAPTURE_RECEIPT_REQUIRED",
      "Hardened review requires the active terminal capture receipt.",
    );
  }
  return {
    turnId: binding.turnId,
    terminalMarker: binding.terminalMarker,
    responseSha256: binding.responseSha256,
    resultEnvelopeSha256: binding.resultEnvelopeSha256,
    conversationIdentity: binding.conversationIdentity,
    routing: current.outbound.routing,
    captureState: "terminal",
    truncated: false,
    captureSha256: binding.responseSha256,
    providerMessageFingerprint:
      current.outbound.confirmationEvidence?.providerMessageFingerprint ?? null,
    captureReceiptPath: binding.captureReceiptPath,
    captureReceiptSha256: binding.captureReceiptSha256,
  };
}

async function assertStoredObject({
  root,
  objectPath,
  expectedSha256,
  expectedBytes,
  label,
}) {
  const expectedPath = `objects/${expectedSha256}.${label}`;
  if (objectPath !== expectedPath) {
    fail(
      "TERMINAL_CAPTURE_RECEIPT_INVALID",
      "Terminal capture receipt contains a non-canonical object path.",
    );
  }
  const bytes = await readRealFile(
    path.join(root, objectPath),
    "TERMINAL_CAPTURE_OBJECT",
    label === "response.txt" ? MAX_CAPTURE_BYTES : LIMITS_V1.result.maxResultBytes,
  );
  if (
    bytes.byteLength !== expectedBytes ||
    sha256(bytes) !== expectedSha256
  ) {
    fail(
      "TERMINAL_CAPTURE_OBJECT_DIGEST_MISMATCH",
      "Stored terminal capture evidence no longer matches its receipt.",
    );
  }
  return bytes;
}

export async function validateTerminalCaptureReceipt({
  stateDir,
  runId,
  current,
  data,
}) {
  if (
    !path.isAbsolute(data.captureReceiptPath ?? "") ||
    !SHA256.test(data.captureReceiptSha256 ?? "")
  ) {
    fail(
      "TERMINAL_CAPTURE_RECEIPT_REQUIRED",
      "Hardened terminal events require an absolute digest-bound capture receipt.",
    );
  }
  const directoryInfo = await prepareDirectory(stateDir, runId);
  const canonicalReceipt = await realpath(data.captureReceiptPath).catch(() => null);
  if (
    !canonicalReceipt ||
    path.dirname(canonicalReceipt) !== path.join(directoryInfo.root, "receipts")
  ) {
    fail(
      "TERMINAL_CAPTURE_RECEIPT_INVALID",
      "Terminal capture receipt is outside the run evidence directory.",
    );
  }
  const receiptBytes = await readRealFile(
    canonicalReceipt,
    "TERMINAL_CAPTURE_RECEIPT",
    MAX_RECEIPT_BYTES,
  );
  if (sha256(receiptBytes) !== data.captureReceiptSha256) {
    fail(
      "TERMINAL_CAPTURE_RECEIPT_DIGEST_MISMATCH",
      "Terminal capture receipt digest does not match.",
    );
  }
  const receipt = parseReceipt(receiptBytes);
  if (
    canonicalReceipt !==
      path.join(directoryInfo.root, "receipts", `${receipt.receiptId}.json`)
  ) {
    fail(
      "TERMINAL_CAPTURE_RECEIPT_INVALID",
      "Terminal capture receipt path does not match its receipt ID.",
    );
  }
  const slotPath = path.join(
    directoryInfo.root,
    "slots",
    `${receipt.slotId}.json`,
  );
  const slotBytes = await readRealFile(
    slotPath,
    "TERMINAL_CAPTURE_SLOT",
    MAX_RECEIPT_BYTES,
  );
  parseSlot(slotBytes, receipt, data.captureReceiptSha256);
  const captureBytes = await assertStoredObject({
    root: directoryInfo.root,
    objectPath: receipt.capture.objectPath,
    expectedSha256: receipt.capture.sha256,
    expectedBytes: receipt.capture.bytes,
    label: "response.txt",
  });
  const resultBytes = await assertStoredObject({
    root: directoryInfo.root,
    objectPath: receipt.resultEnvelope.objectPath,
    expectedSha256: receipt.resultEnvelope.sha256,
    expectedBytes: receipt.resultEnvelope.bytes,
    label: "result.json",
  });
  const extracted = extractResultBytes(
    decodeUtf8(captureBytes, "Terminal capture"),
    current.outbound.expectedTerminalMarker,
  );
  if (!extracted.equals(resultBytes)) {
    fail(
      "TERMINAL_CAPTURE_RESULT_MISMATCH",
      "Stored result bytes do not match the terminal capture boundaries.",
    );
  }
  const resultText = decodeUtf8(resultBytes, "Result envelope");
  if (receipt.resultValidation?.status === "rejected") {
    let rejection = null;
    try {
      parseResultEnvelope(resultText);
    } catch (error) {
      rejection = error;
    }
    if (
      !rejection ||
      rejection.code !== receipt.resultValidation.errorCode
    ) {
      fail(
        "TERMINAL_CAPTURE_REJECTION_MISMATCH",
        "Rejected result bytes no longer reproduce the recorded validation error.",
      );
    }
  } else {
    const envelope = parseResultEnvelope(resultText);
    assertEnvelopeBinding(envelope, current);
  }
  const bindings = receipt.bindings;
  if (
    bindings.runId !== current.runId ||
    bindings.turnId !== current.outbound.turnId ||
    bindings.contextSha256 !== current.outbound.contextSha256 ||
    bindings.taskEnvelopeSha256 !== current.outbound.taskEnvelopeSha256 ||
    bindings.outboundBindingVersion !== 2 ||
    !routingMatches(bindings.routing, current.outbound.routing) ||
    bindings.providerNamespace !== current.outbound.providerNamespace ||
    bindings.conversationIdentity !== current.outbound.conversationIdentity ||
    bindings.terminalMarker !== current.outbound.expectedTerminalMarker ||
    bindings.providerMessageFingerprint !==
      (current.outbound.confirmationEvidence?.providerMessageFingerprint ?? null)
  ) {
    fail(
      "TERMINAL_CAPTURE_BINDING_MISMATCH",
      "Terminal capture receipt does not bind the active routed turn.",
    );
  }
  const expectedEventData = eventDataFromReceipt(
    receipt,
    canonicalReceipt,
    data.captureReceiptSha256,
  );
  if (stable(expectedEventData) !== stable(data)) {
    fail(
      "TERMINAL_CAPTURE_EVENT_MISMATCH",
      "response_terminal data does not exactly match the capture receipt.",
    );
  }
  return receipt;
}

export async function revalidateActiveTerminalCapture({
  stateDir,
  runId,
  current,
}) {
  return validateTerminalCaptureReceipt({
    stateDir,
    runId,
    current,
    data: activeTerminalEventData(current),
  });
}

export async function createTerminalCaptureReceipt({
  stateDir,
  runId,
  capturePath,
  resultPath,
  resultMode = "accepted",
  scanner = "gitleaks",
  testMode = false,
}) {
  if (!["accepted", "rejected"].includes(resultMode)) {
    fail(
      "TERMINAL_CAPTURE_RESULT_MODE_INVALID",
      "Terminal capture result mode must be accepted or rejected.",
    );
  }
  const run = await loadRun({ stateDir, runId });
  assertRunEligible(run, runId);
  const [captureBytes, resultBytes] = await Promise.all([
    readRealFile(capturePath, "TERMINAL_CAPTURE", MAX_CAPTURE_BYTES),
    readRealFile(resultPath, "TERMINAL_RESULT", LIMITS_V1.result.maxResultBytes),
  ]);
  const captureText = decodeUtf8(captureBytes, "Terminal capture");
  const resultText = decodeUtf8(resultBytes, "Result envelope");
  const extracted = extractResultBytes(
    captureText,
    run.outbound.expectedTerminalMarker,
  );
  if (!extracted.equals(resultBytes)) {
    fail(
      "TERMINAL_CAPTURE_RESULT_MISMATCH",
      "Saved result bytes do not exactly match the terminal capture boundaries.",
    );
  }
  let resultValidation = { status: "accepted", errorCode: null };
  if (resultMode === "accepted") {
    const envelope = parseResultEnvelope(resultText);
    assertEnvelopeBinding(envelope, run);
  } else {
    let rejection = null;
    try {
      parseResultEnvelope(resultText);
    } catch (error) {
      rejection = error;
    }
    if (!/^RESULT_[A-Z0-9_]+$/.test(rejection?.code ?? "")) {
      fail(
        "TERMINAL_CAPTURE_REJECTION_UNJUSTIFIED",
        "Rejected capture mode requires an invalid collaboration result.",
      );
    }
    resultValidation = {
      status: "rejected",
      errorCode: rejection.code,
    };
  }
  const receipt = buildReceipt({
    run,
    captureBytes,
    resultBytes,
    resultValidation,
  });
  const serialized = Buffer.from(`${stable(receipt)}\n`);
  if (serialized.byteLength > MAX_RECEIPT_BYTES) {
    fail(
      "TERMINAL_CAPTURE_RECEIPT_INVALID",
      `Terminal capture receipt exceeds ${MAX_RECEIPT_BYTES} bytes.`,
    );
  }
  const receiptSha256 = sha256(serialized);
  const scan = await scanInputs({
    captureBytes,
    resultBytes,
    serialized,
    scanner,
    testMode,
  });
  const directoryInfo = await prepareDirectory(stateDir, runId);
  const lockPath = path.join(
    directoryInfo.root,
    ".locks",
    `${receipt.slotId}.lock`,
  );
  const result = await withOwnedFileLock({
    lockPath,
    busyCode: "TERMINAL_CAPTURE_SLOT_BUSY",
    busyMessage: "Another writer holds the terminal capture slot.",
  }, async () => {
    const current = await loadRun({ stateDir, runId });
    assertRunEligible(current, runId);
    if (
      current.eventCount !== run.eventCount ||
      current.lastEventHash !== run.lastEventHash ||
      stable(current.outbound) !== stable(run.outbound)
    ) {
      fail(
        "TERMINAL_CAPTURE_RUN_CHANGED",
        "Run head changed before terminal capture evidence could be committed.",
      );
    }
    const captureObject = path.join(
      directoryInfo.root,
      receipt.capture.objectPath,
    );
    const resultObject = path.join(
      directoryInfo.root,
      receipt.resultEnvelope.objectPath,
    );
    const receiptPath = path.join(
      directoryInfo.root,
      "receipts",
      `${receipt.receiptId}.json`,
    );
    const slotPath = path.join(
      directoryInfo.root,
      "slots",
      `${receipt.slotId}.json`,
    );
    const existingSlot = await readExisting(
      slotPath,
      MAX_RECEIPT_BYTES,
      "TERMINAL_CAPTURE_SLOT_INVALID",
    );
    if (existingSlot) {
      try {
        parseSlot(existingSlot, receipt, receiptSha256);
      } catch (error) {
        if (
          error.code === "TERMINAL_CAPTURE_SLOT_INVALID" ||
          error.code === "TERMINAL_CAPTURE_SLOT_MISMATCH"
        ) {
          fail(
            "TERMINAL_CAPTURE_SLOT_CONFLICT",
            "Terminal capture slot already binds different evidence.",
          );
        }
        throw error;
      }
      await Promise.all([
        assertExistingExact(
          captureObject,
          captureBytes,
          MAX_CAPTURE_BYTES,
          "TERMINAL_CAPTURE_OBJECT_CONFLICT",
        ),
        assertExistingExact(
          resultObject,
          resultBytes,
          LIMITS_V1.result.maxResultBytes,
          "TERMINAL_CAPTURE_OBJECT_CONFLICT",
        ),
        assertExistingExact(
          receiptPath,
          serialized,
          MAX_RECEIPT_BYTES,
          "TERMINAL_CAPTURE_RECEIPT_CONFLICT",
        ),
      ]);
      return { receiptPath, slotPath, idempotent: true };
    }
    await Promise.all([
      writeOrVerify(
        captureObject,
        captureBytes,
        directoryInfo,
        MAX_CAPTURE_BYTES,
        "TERMINAL_CAPTURE_OBJECT_CONFLICT",
      ),
      writeOrVerify(
        resultObject,
        resultBytes,
        directoryInfo,
        LIMITS_V1.result.maxResultBytes,
        "TERMINAL_CAPTURE_OBJECT_CONFLICT",
      ),
      writeOrVerify(
        receiptPath,
        serialized,
        directoryInfo,
        MAX_RECEIPT_BYTES,
        "TERMINAL_CAPTURE_RECEIPT_CONFLICT",
      ),
    ]);
    const slotBytes = Buffer.from(`${stable({
      kind: "CODEX_CHAT_TERMINAL_CAPTURE_SLOT_V1",
      protocolVersion: 1,
      slotId: receipt.slotId,
      receiptId: receipt.receiptId,
      receiptSha256,
    })}\n`);
    const slotParent = path.dirname(slotPath);
    const slotParentIdentity = directoryInfo.parentIdentities.get(slotParent);
    if (!slotParentIdentity) {
      fail(
        "TERMINAL_CAPTURE_SLOT_INVALID",
        "Terminal capture slot parent is not an approved directory.",
      );
    }
    await atomicWrite(slotPath, slotBytes, {
      parent: slotParent,
      parentIdentity: slotParentIdentity,
    }).catch((error) => {
      if (error.code === "OUTPUT_EXISTS") {
        fail(
          "TERMINAL_CAPTURE_SLOT_CONFLICT",
          "Terminal capture slot appeared during creation.",
        );
      }
      throw error;
    });
    return { receiptPath, slotPath, idempotent: false };
  });
  return {
    artifactPath: result.receiptPath,
    slotPath: result.slotPath,
    size: serialized.byteLength,
    sha256: receiptSha256,
    receiptId: receipt.receiptId,
    slotId: receipt.slotId,
    captureSha256: receipt.capture.sha256,
    resultEnvelopeSha256: receipt.resultEnvelope.sha256,
    eventData: eventDataFromReceipt(
      receipt,
      result.receiptPath,
      receiptSha256,
    ),
    scanner: scan,
    idempotent: result.idempotent,
  };
}
