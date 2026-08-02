import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fail } from "./errors.mjs";

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const OPTION_KEYS = new Set([
  "maxBytes",
  "minBytes",
  "optional",
  "requirePrivate",
]);

function validateInput(filePath, options) {
  if (
    typeof filePath !== "string" ||
    filePath.length === 0 ||
    Buffer.byteLength(filePath) > 4096 ||
    filePath.includes("\0") ||
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    !Object.hasOwn(options, "maxBytes") ||
    Object.keys(options).some((key) => !OPTION_KEYS.has(key))
  ) {
    fail(
      "TRUSTED_FILE_INPUT_INVALID",
      "Trusted file snapshot input is malformed.",
    );
  }
  const maxBytes = options.maxBytes;
  const minBytes = options.minBytes ?? 0;
  const optional = options.optional ?? false;
  const requirePrivate = options.requirePrivate ?? false;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_SNAPSHOT_BYTES ||
    !Number.isSafeInteger(minBytes) ||
    minBytes < 0 ||
    minBytes > maxBytes ||
    typeof optional !== "boolean" ||
    typeof requirePrivate !== "boolean"
  ) {
    fail(
      "TRUSTED_FILE_INPUT_INVALID",
      "Trusted file snapshot policy is malformed.",
    );
  }
  if (
    !Number.isInteger(fsConstants.O_NOFOLLOW) ||
    fsConstants.O_NOFOLLOW === 0
  ) {
    fail(
      "TRUSTED_FILE_PLATFORM_UNSUPPORTED",
      "Trusted file snapshots require no-follow file opens.",
    );
  }
  return {
    path: path.resolve(filePath),
    maxBytes,
    minBytes,
    optional,
    requirePrivate,
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshotMetadata(left, right) {
  return sameIdentity(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function validateOpenedFile(info, policy) {
  if (!info.isFile()) {
    fail(
      "TRUSTED_FILE_TYPE_INVALID",
      "Trusted file snapshot target must be a regular file.",
    );
  }
  if (info.size < policy.minBytes) {
    fail(
      "TRUSTED_FILE_TOO_SMALL",
      "Trusted file snapshot target is below its minimum byte size.",
    );
  }
  if (info.size > policy.maxBytes) {
    fail(
      "TRUSTED_FILE_TOO_LARGE",
      "Trusted file snapshot target exceeds its maximum byte size.",
    );
  }
  if (policy.requirePrivate && (info.mode & 0o077) !== 0) {
    fail(
      "TRUSTED_FILE_PERMISSIONS_INVALID",
      "Trusted file snapshot target must not be group or world accessible.",
    );
  }
}

async function readBounded(handle, maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  while (totalBytes <= maxBytes) {
    const remaining = maxBytes + 1 - totalBytes;
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes > maxBytes) {
    fail(
      "TRUSTED_FILE_TOO_LARGE",
      "Trusted file snapshot target grew beyond its maximum byte size.",
    );
  }
  return Buffer.concat(chunks, totalBytes);
}

export async function readTrustedFileSnapshot(filePath, options = {}) {
  const policy = validateInput(filePath, options);
  let handle;
  try {
    handle = await open(
      policy.path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      if (policy.optional) return null;
      fail("TRUSTED_FILE_MISSING", "Trusted file snapshot target is missing.");
    }
    if (["EACCES", "ELOOP", "ENOTDIR", "EPERM"].includes(error.code)) {
      fail(
        "TRUSTED_FILE_PATH_INVALID",
        "Trusted file snapshot target cannot be opened without following links.",
      );
    }
    throw error;
  }

  try {
    const before = await handle.stat();
    validateOpenedFile(before, policy);
    const bytes = await readBounded(handle, policy.maxBytes);
    const [after, finalPath] = await Promise.all([
      handle.stat(),
      lstat(policy.path).catch(() => null),
    ]);
    if (
      bytes.byteLength !== before.size ||
      !sameSnapshotMetadata(before, after) ||
      !finalPath ||
      finalPath.isSymbolicLink() ||
      !sameSnapshotMetadata(before, finalPath)
    ) {
      fail(
        "TRUSTED_FILE_CHANGED",
        "Trusted file snapshot target changed while it was read.",
      );
    }
    return Object.freeze({
      path: policy.path,
      bytes,
      size: bytes.byteLength,
      mode: before.mode,
      identity: Object.freeze({
        dev: before.dev,
        ino: before.ino,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
      }),
    });
  } finally {
    await handle.close();
  }
}
