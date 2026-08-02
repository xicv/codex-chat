import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
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
import {
  holdOwnedFileLock,
  withOwnedFileLock,
} from "./file-lock.mjs";
import { atomicWrite } from "./pack.mjs";
import { scanDirectory } from "./scanner.mjs";

const STORES = new WeakMap();
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function validCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{2,127}$/u.test(value);
}

function validateCodes(codes) {
  const keys = [
    "directoryInvalid",
    "parentChanged",
    "slotBusy",
    "slotConflict",
  ];
  if (
    !codes ||
    typeof codes !== "object" ||
    Array.isArray(codes) ||
    Object.keys(codes).length !== keys.length ||
    keys.some((key) => !validCode(codes[key]))
  ) {
    fail(
      "IMMUTABLE_EVIDENCE_POLICY_INVALID",
      "Immutable evidence error policy is malformed.",
    );
  }
  return Object.freeze({ ...codes });
}

function validateRelativePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(
      "IMMUTABLE_EVIDENCE_PATH_INVALID",
      `${label} must be a bounded portable relative path.`,
    );
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    fail(
      "IMMUTABLE_EVIDENCE_PATH_INVALID",
      `${label} must not contain traversal or normalization aliases.`,
    );
  }
  return value;
}

async function prepareRealDirectory(directory, code) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory).catch(() => null);
  if (
    !info?.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0
  ) {
    fail(code, "Immutable evidence directories must be private real directories.");
  }
  const canonical = await realpath(directory);
  const identity = await stat(canonical);
  return {
    canonical,
    identity: { dev: identity.dev, ino: identity.ino },
  };
}

export async function openImmutableEvidenceStore({
  root,
  directories = [],
  codes,
}) {
  const policy = validateCodes(codes);
  if (!Array.isArray(directories) || directories.length > 32) {
    fail(
      "IMMUTABLE_EVIDENCE_POLICY_INVALID",
      "Immutable evidence directory policy is malformed.",
    );
  }
  if (typeof root !== "string" || root.length === 0 || root.length > 4096) {
    fail(
      policy.directoryInvalid,
      "Immutable evidence root path is invalid.",
    );
  }
  const requestedRoot = path.resolve(root);
  const requestedParent = path.dirname(requestedRoot);
  const parentInfo = await lstat(requestedParent).catch(() => null);
  if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) {
    fail(
      policy.directoryInvalid,
      "Immutable evidence root parent must be an existing real directory.",
    );
  }
  const canonicalParent = await realpath(requestedParent);
  const rootInfo = await prepareRealDirectory(
    path.join(canonicalParent, path.basename(requestedRoot)),
    policy.directoryInvalid,
  );
  const identities = new Map([
    [rootInfo.canonical, rootInfo.identity],
  ]);
  const unique = new Set();
  for (const relative of directories) {
    validateRelativePath(relative, "Evidence directory");
    if (path.basename(relative) !== relative || unique.has(relative)) {
      fail(
        "IMMUTABLE_EVIDENCE_POLICY_INVALID",
        "Immutable evidence directories must be unique direct children.",
      );
    }
    unique.add(relative);
    const prepared = await prepareRealDirectory(
      path.join(rootInfo.canonical, relative),
      policy.directoryInvalid,
    );
    if (!prepared.canonical.startsWith(`${rootInfo.canonical}${path.sep}`)) {
      fail(
        policy.directoryInvalid,
        "Immutable evidence directory escaped its approved root.",
      );
    }
    identities.set(prepared.canonical, prepared.identity);
  }
  if (!identities.has(path.join(rootInfo.canonical, ".locks"))) {
    fail(
      "IMMUTABLE_EVIDENCE_POLICY_INVALID",
      "Immutable evidence stores require a declared .locks directory.",
    );
  }
  const store = Object.freeze({ root: rootInfo.canonical });
  STORES.set(store, { identities, codes: policy });
  return store;
}

export async function scanImmutableEvidence({
  entries,
  scanner,
  testMode = false,
  prefix = "codex-chat-evidence-scan-",
}) {
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    entries.length > 32 ||
    typeof prefix !== "string" ||
    !/^[a-z0-9-]{1,64}$/u.test(prefix)
  ) {
    fail(
      "IMMUTABLE_EVIDENCE_SCAN_INVALID",
      "Immutable evidence scan inputs are malformed.",
    );
  }
  const seen = new Set();
  let totalBytes = 0;
  const prepared = entries.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.name !== "string" ||
      path.basename(entry.name) !== entry.name ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.name) ||
      seen.has(entry.name) ||
      !(entry.bytes instanceof Uint8Array)
    ) {
      fail(
        "IMMUTABLE_EVIDENCE_SCAN_INVALID",
        "Immutable evidence scan entries are malformed.",
      );
    }
    seen.add(entry.name);
    totalBytes += entry.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SCAN_BYTES) {
      fail(
        "IMMUTABLE_EVIDENCE_SCAN_INVALID",
        "Immutable evidence scan inputs exceed the bounded size.",
      );
    }
    return { name: entry.name, bytes: Buffer.from(entry.bytes) };
  });
  const staging = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await Promise.all(prepared.map((entry) => writeFile(
      path.join(staging, entry.name),
      entry.bytes,
      { mode: 0o600, flag: "wx" },
    )));
    return await scanDirectory(staging, scanner, { testMode });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function assertStoreIdentity(store) {
  const state = STORES.get(store);
  for (const [directory, expected] of state.identities) {
    const pathInfo = await lstat(directory).catch(() => null);
    if (
      !pathInfo?.isDirectory() ||
      pathInfo.isSymbolicLink() ||
      (pathInfo.mode & 0o077) !== 0
    ) {
      fail(
        state.codes.parentChanged,
        "Immutable evidence directory identity changed.",
      );
    }
    const current = await stat(directory).catch(() => null);
    if (
      !current ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) {
      fail(
        state.codes.parentChanged,
        "Immutable evidence directory identity changed.",
      );
    }
  }
}

function targetFor(store, relativePath, label) {
  validateRelativePath(relativePath, label);
  const target = path.join(store.root, relativePath);
  const parent = path.dirname(target);
  const parentIdentity = STORES.get(store).identities.get(parent);
  if (!parentIdentity) {
    fail(
      "IMMUTABLE_EVIDENCE_PATH_INVALID",
      `${label} parent is not an approved evidence directory.`,
    );
  }
  return { target, parent, parentIdentity };
}

function boundedBytes(value, maxBytes, label) {
  if (
    !(value instanceof Uint8Array) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    value.byteLength < 1 ||
    value.byteLength > maxBytes
  ) {
    fail(
      "IMMUTABLE_EVIDENCE_INPUT_INVALID",
      `${label} bytes or size limit is invalid.`,
    );
  }
  return Buffer.from(value);
}

async function readExisting(filePath, maxBytes, conflictCode) {
  const pathInfo = await lstat(filePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (pathInfo === null) return null;
  if (
    !pathInfo.isFile() ||
    pathInfo.isSymbolicLink() ||
    (pathInfo.mode & 0o077) !== 0 ||
    pathInfo.size > maxBytes
  ) {
    fail(conflictCode, "Existing immutable evidence is invalid.");
  }
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      (opened.mode & 0o077) !== 0 ||
      opened.dev !== pathInfo.dev ||
      opened.ino !== pathInfo.ino ||
      opened.size !== pathInfo.size ||
      opened.mtimeMs !== pathInfo.mtimeMs ||
      opened.ctimeMs !== pathInfo.ctimeMs ||
      opened.size > maxBytes
    ) {
      fail(conflictCode, "Immutable evidence changed while it was opened.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const finalPath = await lstat(filePath).catch(() => null);
    if (
      bytes.byteLength > maxBytes ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      !finalPath ||
      finalPath.isSymbolicLink() ||
      finalPath.dev !== opened.dev ||
      finalPath.ino !== opened.ino ||
      finalPath.size !== opened.size ||
      finalPath.mtimeMs !== opened.mtimeMs ||
      finalPath.ctimeMs !== opened.ctimeMs
    ) {
      fail(conflictCode, "Immutable evidence changed while it was read.");
    }
    return bytes;
  } catch (error) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes(error.code)) {
      fail(conflictCode, "Immutable evidence changed while it was opened.");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function assertExact(filePath, expected, maxBytes, conflictCode) {
  const existing = await readExisting(filePath, maxBytes, conflictCode);
  if (!existing?.equals(expected)) {
    fail(conflictCode, "Immutable evidence contains different bytes.");
  }
}

async function writeOrVerify(
  targetInfo,
  bytes,
  maxBytes,
  conflictCode,
  parentChangedCode,
) {
  const existing = await readExisting(targetInfo.target, maxBytes, conflictCode);
  if (existing !== null) {
    if (!existing.equals(bytes)) {
      fail(conflictCode, "Immutable evidence contains different bytes.");
    }
    return false;
  }
  try {
    await atomicWrite(targetInfo.target, bytes, targetInfo);
    return true;
  } catch (error) {
    if (error.code === "OUTPUT_PARENT_CHANGED") {
      fail(parentChangedCode, "Immutable evidence directory identity changed.");
    }
    if (error.code !== "OUTPUT_EXISTS") throw error;
    await assertExact(targetInfo.target, bytes, maxBytes, conflictCode);
    return false;
  }
}

function validatePublication(store, { slotId, slot, artifacts, authority }) {
  if (!STORES.has(store) || !ID.test(slotId ?? "")) {
    fail(
      "IMMUTABLE_EVIDENCE_INPUT_INVALID",
      "Immutable evidence store or slot identity is invalid.",
    );
  }
  if (
    !slot ||
    typeof slot !== "object" ||
    Array.isArray(slot) ||
    !Array.isArray(artifacts) ||
    artifacts.length === 0 ||
    artifacts.length > 32
  ) {
    fail(
      "IMMUTABLE_EVIDENCE_INPUT_INVALID",
      "Immutable evidence publication is malformed.",
    );
  }
  const slotBytes = boundedBytes(slot.bytes, slot.maxBytes, "Slot");
  const slotTarget = targetFor(store, slot.relativePath, "Slot");
  const seen = new Set([slotTarget.target]);
  const preparedArtifacts = artifacts.map((artifact) => {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      fail(
        "IMMUTABLE_EVIDENCE_INPUT_INVALID",
        "Immutable evidence artifact is malformed.",
      );
    }
    if (!validCode(artifact.conflictCode)) {
      fail(
        "IMMUTABLE_EVIDENCE_POLICY_INVALID",
        "Immutable evidence artifact conflict policy is malformed.",
      );
    }
    const target = targetFor(store, artifact.relativePath, "Artifact");
    if (seen.has(target.target)) {
      fail(
        "IMMUTABLE_EVIDENCE_INPUT_INVALID",
        "Immutable evidence target paths must be unique.",
      );
    }
    seen.add(target.target);
    return {
      ...target,
      bytes: boundedBytes(artifact.bytes, artifact.maxBytes, "Artifact"),
      maxBytes: artifact.maxBytes,
      conflictCode: artifact.conflictCode,
      relativePath: artifact.relativePath,
    };
  });
  if (
    authority !== null &&
    authority !== undefined &&
    (
      typeof authority !== "object" ||
      Array.isArray(authority) ||
      typeof authority.assertCurrent !== "function" ||
      (
        authority.lockPath !== undefined &&
        (
          !path.isAbsolute(authority.lockPath) ||
          !validCode(authority.busyCode) ||
          typeof authority.busyMessage !== "string"
        )
      )
    )
  ) {
    fail(
      "IMMUTABLE_EVIDENCE_POLICY_INVALID",
      "Immutable evidence authority policy is malformed.",
    );
  }
  return {
    slot: {
      ...slotTarget,
      bytes: slotBytes,
      maxBytes: slot.maxBytes,
    },
    artifacts: preparedArtifacts,
  };
}

function publicationResult(publication, idempotent) {
  return {
    slotPath: publication.slot.target,
    artifactPaths: Object.fromEntries(publication.artifacts.map(
      (artifact) => [artifact.relativePath, artifact.target],
    )),
    idempotent,
  };
}

async function withArtifactLocks(store, storeState, artifacts, operation) {
  const lockPaths = artifacts.map((artifact) => path.join(
    store.root,
    ".locks",
    `.artifact-${sha256(artifact.relativePath)}.lock`,
  )).sort();
  const releases = [];
  try {
    for (const lockPath of lockPaths) {
      releases.push(await holdOwnedFileLock({
        lockPath,
        busyCode: storeState.codes.slotBusy,
        busyMessage: "Another writer holds a shared immutable evidence artifact.",
      }));
    }
    return await operation();
  } finally {
    for (const release of releases.reverse()) await release();
  }
}

export async function publishImmutableEvidence({
  store,
  slotId,
  slot,
  artifacts,
  authority = null,
}) {
  const publication = validatePublication(store, {
    slotId,
    slot,
    artifacts,
    authority,
  });
  const storeState = STORES.get(store);
  await assertStoreIdentity(store);
  const commit = async () => {
    await assertStoreIdentity(store);
    await authority?.assertCurrent();
    const existingSlot = await readExisting(
      publication.slot.target,
      publication.slot.maxBytes,
      storeState.codes.slotConflict,
    );
    if (existingSlot !== null) {
      if (!existingSlot.equals(publication.slot.bytes)) {
        fail(storeState.codes.slotConflict, "Immutable evidence slot is already bound.");
      }
      await Promise.all(publication.artifacts.map((artifact) =>
        assertExact(
          artifact.target,
          artifact.bytes,
          artifact.maxBytes,
          artifact.conflictCode,
        )
      ));
      await assertStoreIdentity(store);
      return publicationResult(publication, true);
    }

    return withArtifactLocks(
      store,
      storeState,
      publication.artifacts,
      async () => {
        await assertStoreIdentity(store);
        await authority?.assertCurrent();
        await Promise.all(publication.artifacts.map((artifact) =>
          writeOrVerify(
            artifact,
            artifact.bytes,
            artifact.maxBytes,
            artifact.conflictCode,
            storeState.codes.parentChanged,
          )
        ));
        try {
          await atomicWrite(
            publication.slot.target,
            publication.slot.bytes,
            publication.slot,
          );
        } catch (error) {
          if (error.code === "OUTPUT_PARENT_CHANGED") {
            fail(
              storeState.codes.parentChanged,
              "Immutable evidence directory identity changed.",
            );
          }
          if (error.code !== "OUTPUT_EXISTS") throw error;
          const raced = await readExisting(
            publication.slot.target,
            publication.slot.maxBytes,
            storeState.codes.slotConflict,
          );
          if (!raced?.equals(publication.slot.bytes)) {
            fail(
              storeState.codes.slotConflict,
              "Immutable evidence slot appeared with different bytes.",
            );
          }
          await assertStoreIdentity(store);
          return publicationResult(publication, true);
        }
        await assertStoreIdentity(store);
        return publicationResult(publication, false);
      },
    );
  };

  return withOwnedFileLock({
    lockPath: path.join(store.root, ".locks", `${slotId}.lock`),
    busyCode: storeState.codes.slotBusy,
    busyMessage: "Another writer holds the immutable evidence slot.",
  }, async () => {
    if (authority?.lockPath === undefined) return commit();
    return withOwnedFileLock({
      lockPath: authority.lockPath,
      busyCode: authority.busyCode,
      busyMessage: authority.busyMessage,
    }, commit);
  });
}
