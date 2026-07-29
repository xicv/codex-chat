import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fail } from "./errors.mjs";
import { validateRelativePath } from "./preflight.mjs";
import { scanDirectory } from "./scanner.mjs";
import { LIMITS_V1 } from "./limits.mjs";

const {
  maxResultBytes: MAX_RESULT_BYTES,
  maxPatchBytes: MAX_PATCH_BYTES,
  maxPatchLines: MAX_PATCH_LINES,
  maxHunks: MAX_HUNKS,
  maxPostimageBytes: MAX_POSTIMAGE_BYTES,
} = LIMITS_V1.result;

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

export function parseResultEnvelope(raw) {
  if (Buffer.byteLength(raw) > MAX_RESULT_BYTES) {
    fail("RESULT_TOO_LARGE", `Result exceeds ${MAX_RESULT_BYTES} bytes.`);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("RESULT_JSON_INVALID", "Collaboration result is not valid JSON.");
  }
  if (
    !value ||
    value.kind !== "COLLAB_RESULT_V1" ||
    value.protocolVersion !== 1 ||
    typeof value.runId !== "string" ||
    typeof value.turnId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.contextSha256 ?? "") ||
    value.complete !== true ||
    !["patch", "advisory"].includes(value.artifactKind) ||
    typeof value.summary !== "string" ||
    !value.claims ||
    typeof value.claims !== "object" ||
    Array.isArray(value.claims)
  ) {
    fail("RESULT_SCHEMA_INVALID", "Collaboration result does not match COLLAB_RESULT_V1.");
  }
  const common = new Set([
    "kind",
    "protocolVersion",
    "runId",
    "turnId",
    "contextSha256",
    "complete",
    "artifactKind",
    "summary",
    "claims",
  ]);
  const allowed =
    value.artifactKind === "patch"
      ? new Set([...common, "patch", "preimages"])
      : common;
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail("RESULT_SCHEMA_INVALID", "Collaboration result contains unsupported fields.");
  }
  if (value.artifactKind === "advisory") return value;
  if (
    value.patch?.format !== "unified-diff" ||
    typeof value.patch?.content !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.patch?.sha256 ?? "") ||
    !Array.isArray(value.preimages)
  ) {
    fail("RESULT_SCHEMA_INVALID", "Patch result does not match COLLAB_RESULT_V1.");
  }
  if (Buffer.byteLength(value.patch.content) > MAX_PATCH_BYTES) {
    fail("PATCH_TOO_LARGE", `Patch exceeds ${MAX_PATCH_BYTES} bytes.`);
  }
  if (sha256(value.patch.content) !== value.patch.sha256) {
    fail("PATCH_DIGEST_INVALID", "Patch SHA-256 does not match the envelope.");
  }
  return value;
}

function headerPath(line, prefix) {
  if (!line.startsWith(prefix)) {
    fail("PATCH_FORMAT_UNSUPPORTED", `Expected ${prefix.trim()} header.`);
  }
  const raw = line.slice(prefix.length);
  if (raw === "/dev/null" || raw.includes("\t")) {
    fail("PATCH_FORMAT_UNSUPPORTED", "Creation, deletion, and timestamped headers are not supported.");
  }
  if (!raw.startsWith("a/") && prefix === "--- ") {
    fail("PATCH_FORMAT_UNSUPPORTED", "Old patch path must start with a/.");
  }
  if (!raw.startsWith("b/") && prefix === "+++ ") {
    fail("PATCH_FORMAT_UNSUPPORTED", "New patch path must start with b/.");
  }
  return validateRelativePath(raw.slice(2));
}

function parseUnifiedDiff(content) {
  if (content.includes("\0") || content.includes("\r") || !content.endsWith("\n")) {
    fail("PATCH_FORMAT_UNSUPPORTED", "Patch must be NUL-free LF text ending in a newline.");
  }
  const lines = content.split("\n");
  lines.pop();
  if (lines.length > MAX_PATCH_LINES) {
    fail("PATCH_TOO_LARGE", `Patch exceeds ${MAX_PATCH_LINES} lines.`);
  }
  if (lines.length < 3) {
    fail("PATCH_FORMAT_UNSUPPORTED", "Patch is incomplete.");
  }
  const oldPath = headerPath(lines[0], "--- ");
  const newPath = headerPath(lines[1], "+++ ");
  if (oldPath !== newPath) {
    fail("PATCH_FORMAT_UNSUPPORTED", "Renames are not supported.");
  }
  const hunks = [];
  let index = 2;
  while (index < lines.length) {
    if (lines[index].startsWith("--- ") || lines[index].startsWith("+++ ")) {
      fail("PATCH_FORMAT_UNSUPPORTED", "Only one file per result is supported.");
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[index]);
    if (!match) {
      fail("PATCH_FORMAT_UNSUPPORTED", `Invalid hunk header: ${lines[index]}`);
    }
    const hunk = {
      oldStart: Number(match[1]),
      oldCount: Number(match[2] ?? 1),
      newStart: Number(match[3]),
      newCount: Number(match[4] ?? 1),
      lines: [],
    };
    index += 1;
    let oldSeen = 0;
    let newSeen = 0;
    while (index < lines.length && !lines[index].startsWith("@@ ")) {
      const line = lines[index];
      if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        fail("PATCH_FORMAT_UNSUPPORTED", "Only one file per result is supported.");
      }
      const marker = line[0];
      if (![" ", "+", "-"].includes(marker)) {
        fail("PATCH_FORMAT_UNSUPPORTED", "Only ordinary text hunks are supported.");
      }
      if (marker !== "+") oldSeen += 1;
      if (marker !== "-") newSeen += 1;
      hunk.lines.push({ marker, text: line.slice(1) });
      index += 1;
    }
    if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) {
      fail("PATCH_COUNT_INVALID", "Hunk header counts do not match hunk contents.");
    }
    hunks.push(hunk);
    if (hunks.length > MAX_HUNKS) {
      fail("PATCH_TOO_LARGE", `Patch exceeds ${MAX_HUNKS} hunks.`);
    }
  }
  if (hunks.length === 0) {
    fail("PATCH_FORMAT_UNSUPPORTED", "Patch contains no hunks.");
  }
  return { path: oldPath, hunks };
}

function applyHunks(before, parsed) {
  if (!before.endsWith("\n") || before.includes("\r")) {
    fail("SOURCE_FORMAT_UNSUPPORTED", "Patched source must be LF text ending in a newline.");
  }
  const source = before.slice(0, -1).split("\n");
  const output = [];
  let cursor = 0;
  let outputLine = 1;
  for (const hunk of parsed.hunks) {
    const start = hunk.oldStart - 1;
    if (start < cursor || start > source.length) {
      fail("PATCH_CONTEXT_MISMATCH", "Hunk location is outside the source.");
    }
    output.push(...source.slice(cursor, start));
    outputLine += start - cursor;
    if (outputLine !== hunk.newStart) {
      fail("PATCH_CONTEXT_MISMATCH", "New hunk location is inconsistent.");
    }
    cursor = start;
    for (const line of hunk.lines) {
      if (line.marker === " " || line.marker === "-") {
        if (source[cursor] !== line.text) {
          fail("PATCH_CONTEXT_MISMATCH", `Patch context does not match at old line ${cursor + 1}.`);
        }
        cursor += 1;
      }
      if (line.marker === " " || line.marker === "+") {
        output.push(line.text);
        outputLine += 1;
      }
    }
  }
  output.push(...source.slice(cursor));
  const postimage = `${output.join("\n")}\n`;
  if (Buffer.byteLength(postimage) > MAX_POSTIMAGE_BYTES) {
    fail("POSTIMAGE_TOO_LARGE", `Postimage exceeds ${MAX_POSTIMAGE_BYTES} bytes.`);
  }
  return postimage;
}

async function assertNoSymlinkPath(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (!info) {
      fail("PATCH_TARGET_MISSING", `Patch target does not exist: ${relativePath}`);
    }
    if (info.isSymbolicLink()) {
      fail("SYMLINK_REJECTED", `Patch target crosses a symbolic link: ${relativePath}`);
    }
  }
}

async function atomicWrite(target, contents, mode, expectedParent = null) {
  const temporary = `${target}.codex-chat-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, { mode, flag: "wx" });
  const handle = await open(temporary, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (expectedParent) {
    const currentParent = await stat(path.dirname(target));
    if (
      currentParent.dev !== expectedParent.dev ||
      currentParent.ino !== expectedParent.ino
    ) {
      fail("PATH_IDENTITY_CHANGED", "Target parent changed before atomic replacement.");
    }
  }
  await rename(temporary, target);
  await chmod(target, mode);
  const directory = await open(path.dirname(target), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isWithin(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function inspectRoot(root, label) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    fail(`${label.toUpperCase()}_INVALID`, `${label} must be an absolute directory.`);
  }
  const absolute = path.resolve(root);
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    fail(`${label.toUpperCase()}_INVALID`, `${label} must be a real directory: ${absolute}`);
  }
  const canonical = await realpath(absolute);
  const identity = await stat(canonical);
  return {
    path: canonical,
    dev: identity.dev,
    ino: identity.ino,
    digest: sha256(stable({
      path: canonical,
      dev: identity.dev,
      ino: identity.ino,
    })),
  };
}

async function quarantineEnvelope({
  validated,
  source,
  scratchRoot = null,
  quarantineDir,
  scanner,
  testMode,
}) {
  const requested = path.resolve(quarantineDir);
  if (
    (source.path && isWithin(source.path, requested)) ||
    (scratchRoot && isWithin(scratchRoot.path, requested))
  ) {
    fail(
      "QUARANTINE_CONFINEMENT",
      "Quarantine must be outside the source and scratch roots.",
    );
  }
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const quarantineInfo = await lstat(requested).catch(() => null);
  if (!quarantineInfo?.isDirectory() || quarantineInfo.isSymbolicLink()) {
    fail("QUARANTINE_INVALID", `Quarantine must be a real directory: ${requested}`);
  }
  const absoluteQuarantine = await realpath(requested);
  if (
    (source.path && isWithin(source.path, absoluteQuarantine)) ||
    (scratchRoot && isWithin(scratchRoot.path, absoluteQuarantine))
  ) {
    fail(
      "QUARANTINE_CONFINEMENT",
      "Resolved quarantine must be outside the source and scratch roots.",
    );
  }
  await chmod(absoluteQuarantine, 0o700);
  const canonicalResult = stable(validated);
  const resultDigest = sha256(canonicalResult);
  const applicationKey = sha256(
    `${resultDigest}\0${source.digest}\0${scratchRoot?.digest ?? "advisory"}`,
  );
  const quarantined = path.join(absoluteQuarantine, `${applicationKey}.json`);
  const expectedContents = `${canonicalResult}\n`;
  await writeFile(quarantined, expectedContents, {
    mode: 0o600,
    flag: "wx",
  }).catch(async (error) => {
    if (error.code !== "EEXIST") throw error;
    const existing = await readFile(quarantined, "utf8");
    if (existing !== expectedContents) {
      fail("QUARANTINE_CONFLICT", "Existing quarantine artifact differs.");
    }
  });
  await chmod(quarantined, 0o600);
  const scan = await scanDirectory(quarantined, scanner, { testMode });
  return {
    absoluteQuarantine,
    applicationKey,
    quarantined,
    resultDigest,
    scan,
  };
}

async function readReceipt(receiptPath) {
  const contents = await readFile(receiptPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (contents === null) return null;
  try {
    return JSON.parse(contents);
  } catch {
    fail("IMPORT_RECEIPT_CORRUPT", `Import receipt is invalid: ${receiptPath}`);
  }
}

function decodeSource(bytes, relativePath) {
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("SOURCE_FORMAT_UNSUPPORTED", `Source is not valid UTF-8: ${relativePath}`);
  }
  if (!value.endsWith("\n") || value.includes("\r") || value.includes("\0")) {
    fail(
      "SOURCE_FORMAT_UNSUPPORTED",
      `Source must be NUL-free LF text ending in a newline: ${relativePath}`,
    );
  }
  return value;
}

export async function importResult({
  envelope,
  scratch,
  sourceRoot,
  quarantineDir,
  allowedPaths,
  expectedRunId,
  expectedTurnId,
  expectedContextSha256,
  scanner = "gitleaks",
  testMode = false,
  crashAfterTarget = false,
}) {
  const validated = parseResultEnvelope(stable(envelope));
  if (
    typeof expectedRunId !== "string" ||
    typeof expectedTurnId !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedContextSha256 ?? "")
  ) {
    fail("RESULT_BINDING_REQUIRED", "Expected run, turn, and context bindings are required.");
  }
  if (validated.runId !== expectedRunId) {
    fail("RESULT_RUN_MISMATCH", "Result runId does not match the durable run.");
  }
  if (validated.turnId !== expectedTurnId) {
    fail("RESULT_TURN_MISMATCH", "Result turnId does not match the reserved outbound turn.");
  }
  if (validated.contextSha256 !== expectedContextSha256) {
    fail("RESULT_CONTEXT_MISMATCH", "Result context digest does not match the active outbound payload.");
  }
  const source =
    validated.artifactKind === "advisory" && sourceRoot == null
      ? {
          path: null,
          dev: null,
          ino: null,
          digest: sha256("codex-chat/advisory/source-less/v1"),
        }
      : await inspectRoot(sourceRoot, "source_root");
  if (validated.artifactKind === "advisory") {
    const quarantine = await quarantineEnvelope({
      validated,
      source,
      quarantineDir,
      scanner,
      testMode,
    });
    const receiptPath = path.join(
      quarantine.absoluteQuarantine,
      `${quarantine.applicationKey}.advisory.receipt.json`,
    );
    const receipt = {
      kind: "CODEX_CHAT_ADVISORY_RECEIPT_V1",
      protocolVersion: 1,
      artifactKind: "advisory",
      runId: validated.runId,
      turnId: validated.turnId,
      contextSha256: validated.contextSha256,
      sourceIdentity: source.digest,
      applicationKey: quarantine.applicationKey,
      resultSha256: quarantine.resultDigest,
      summarySha256: sha256(validated.summary),
      claimsSha256: sha256(stable(validated.claims)),
    };
    const existing = await readReceipt(receiptPath);
    if (existing) {
      if (stable(existing) !== stable(receipt)) {
        fail("IMPORT_RECEIPT_CONFLICT", "Advisory receipt does not match this result.");
      }
      return {
        ...receipt,
        receiptPath,
        quarantined: quarantine.quarantined,
        scanner: quarantine.scan,
        idempotent: true,
      };
    }
    await atomicWrite(receiptPath, `${stable(receipt)}\n`, 0o600);
    return {
      ...receipt,
      receiptPath,
      quarantined: quarantine.quarantined,
      scanner: quarantine.scan,
      idempotent: false,
    };
  }
  const parsed = parseUnifiedDiff(validated.patch.content);
  const allowed = new Set(allowedPaths.map(validateRelativePath));
  if (!allowed.has(parsed.path)) {
    fail("PATCH_OUT_OF_SCOPE", `Patch path is not allowed: ${parsed.path}`);
  }
  if (validated.preimages.length !== 1) {
    fail("RESULT_SCHEMA_INVALID", "Exactly one preimage is required.");
  }
  const preimage = validated.preimages[0];
  if (
    validateRelativePath(preimage.path) !== parsed.path ||
    !/^[a-f0-9]{64}$/.test(preimage.sha256 ?? "")
  ) {
    fail("RESULT_SCHEMA_INVALID", "Preimage does not match the patch target.");
  }

  const scratchRoot = await inspectRoot(scratch, "scratch");
  if (
    isWithin(source.path, scratchRoot.path) ||
    isWithin(scratchRoot.path, source.path)
  ) {
    fail("SCRATCH_CONFINEMENT_INVALID", "Scratch and source roots must be separate, non-nested directories.");
  }
  const absoluteScratch = scratchRoot.path;
  const quarantine = await quarantineEnvelope({
    validated,
    source,
    scratchRoot,
    quarantineDir,
    scanner,
    testMode,
  });
  const {
    absoluteQuarantine,
    applicationKey,
    quarantined,
    scan,
  } = quarantine;

  const marker = path.join(absoluteQuarantine, `${applicationKey}.imported.json`);
  const preparedMarker = path.join(absoluteQuarantine, `${applicationKey}.prepared.json`);
  const existingMarker = await readReceipt(marker);
  const target = path.join(absoluteScratch, parsed.path);
  await assertNoSymlinkPath(absoluteScratch, parsed.path);
  const canonicalTarget = await realpath(target);
  if (!isWithin(absoluteScratch, canonicalTarget)) {
    fail("SCRATCH_ESCAPE", `Resolved target escapes the authorised scratch: ${parsed.path}`);
  }
  const info = await lstat(target);
  if (!info.isFile()) {
    fail("PATCH_TARGET_INVALID", `Patch target is not a regular file: ${parsed.path}`);
  }
  const beforeBytes = await readFile(target);
  const before = decodeSource(beforeBytes, parsed.path);
  const currentSha256 = sha256(beforeBytes);
  if (existingMarker) {
    if (
      existingMarker.applicationKey !== applicationKey ||
      existingMarker.runId !== validated.runId ||
      existingMarker.turnId !== validated.turnId ||
      existingMarker.contextSha256 !== validated.contextSha256
    ) {
      fail("IMPORT_RECEIPT_CONFLICT", "Applied receipt does not match this application.");
    }
    if (currentSha256 !== existingMarker.outputSha256) {
      fail("IDEMPOTENCY_CONFLICT", "Imported target changed after the recorded import.");
    }
    return { ...existingMarker, idempotent: true, quarantined, scanner: scan };
  }
  const prepared = await readReceipt(preparedMarker);
  if (prepared) {
    if (
      prepared.path !== parsed.path ||
      prepared.runId !== validated.runId ||
      prepared.turnId !== validated.turnId ||
      prepared.contextSha256 !== validated.contextSha256 ||
      prepared.sourceIdentity !== source.digest ||
      prepared.scratchIdentity !== scratchRoot.digest ||
      prepared.applicationKey !== applicationKey ||
      prepared.inputSha256 !== preimage.sha256 ||
      prepared.patchSha256 !== validated.patch.sha256
    ) {
      fail("IMPORT_RECEIPT_CONFLICT", "Prepared receipt does not match this result.");
    }
    if (currentSha256 === prepared.outputSha256) {
      await atomicWrite(marker, `${stable(prepared)}\n`, 0o600);
      return {
        ...prepared,
        idempotent: true,
        recovered: true,
        quarantined,
        scanner: scan,
      };
    }
    if (currentSha256 !== prepared.inputSha256) {
      fail("IDEMPOTENCY_CONFLICT", "Target matches neither prepared preimage nor postimage.");
    }
  } else if (currentSha256 !== preimage.sha256) {
    fail("PREIMAGE_STALE", `Patch preimage is stale: ${parsed.path}`);
  }

  const after = applyHunks(before, parsed);
  const result = {
    runId: validated.runId,
    turnId: validated.turnId,
    contextSha256: validated.contextSha256,
    path: parsed.path,
    sourceIdentity: source.digest,
    scratchIdentity: scratchRoot.digest,
    applicationKey,
    inputSha256: preimage.sha256,
    outputSha256: sha256(after),
    patchSha256: validated.patch.sha256,
  };
  if (prepared && prepared.outputSha256 !== result.outputSha256) {
    fail("IMPORT_RECEIPT_CONFLICT", "Prepared postimage differs from the computed patch.");
  }
  if (!prepared) {
    await atomicWrite(preparedMarker, `${stable(result)}\n`, 0o600);
  }
  const targetParent = await stat(path.dirname(target));
  await atomicWrite(target, after, info.mode & 0o777, targetParent);
  if (crashAfterTarget) {
    fail("SIMULATED_CRASH", "Simulated crash after target replacement.");
  }
  await atomicWrite(marker, `${stable(result)}\n`, 0o600);
  return {
    ...result,
    idempotent: false,
    recovered: prepared !== null,
    quarantined,
    scanner: scan,
  };
}
