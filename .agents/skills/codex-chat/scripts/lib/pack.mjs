import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
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
import { validateIncludes } from "./preflight.mjs";
import { scanDirectory } from "./scanner.mjs";
import { LIMITS_V1 } from "./limits.mjs";

const {
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
  maxFiles: DEFAULT_MAX_FILES,
} = LIMITS_V1.pack;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function isSensitivePath(relativePath) {
  const segments = relativePath.toLowerCase().split("/");
  return segments.some((segment) =>
    segment === ".env" ||
    segment.startsWith(".env.") ||
    [
      ".git", ".hg", ".svn", ".jj", ".codex", ".codex-chat",
      "node_modules", ".cache", "cache", "coverage", "dist", "build",
      "browser-profile", "browser_state", "browser-state",
    ].includes(segment) ||
    /^(id_rsa|id_ed25519|credentials|cookies?|tokens?|auth[-_.]?state)(\.|$)/.test(segment) ||
    /\.(pem|key|p12|pfx|kdbx|sqlite|sqlite3|db|db3|mdb|accdb)$/.test(segment)
  );
}

async function collect(root, relativePath, output) {
  const absolutePath = path.join(root, relativePath);
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) {
    fail("SYMLINK_REJECTED", `Symbolic links are not allowed: ${relativePath}`);
  }
  if (isSensitivePath(relativePath)) {
    fail("SENSITIVE_PATH", `Sensitive path is not eligible for collaboration: ${relativePath}`);
  }
  if (!info.isFile()) {
    fail("PATH_TYPE_REJECTED", `Unsupported included path: ${relativePath}`);
  }
  output.add(relativePath);
}

function decodeUtf8(bytes, relativePath) {
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("BINARY_FILE_REJECTED", `Only UTF-8 text files are supported: ${relativePath}`);
  }
  if (value.includes("\0") || value.includes("\r")) {
    fail("TEXT_FORMAT_REJECTED", `Only NUL-free LF text is supported: ${relativePath}`);
  }
  return value;
}

function isWithin(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export async function readSelectedFile(canonicalRoot, relativePath) {
  const absolutePath = path.join(canonicalRoot, relativePath);
  let handle;
  try {
    handle = await open(
      absolutePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes(error.code)) {
      fail(
        "SOURCE_PATH_CHANGED",
        `Selected source path changed before it could be read: ${relativePath}`,
      );
    }
    throw error;
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      fail("PATH_TYPE_REJECTED", `Unsupported included path: ${relativePath}`);
    }

    let componentPath = canonicalRoot;
    for (const segment of relativePath.split("/")) {
      componentPath = path.join(componentPath, segment);
      const component = await lstat(componentPath).catch(() => null);
      if (!component || component.isSymbolicLink()) {
        fail(
          "SOURCE_PATH_CHANGED",
          `Selected source path changed before it could be read: ${relativePath}`,
        );
      }
    }

    const canonicalPath = await realpath(absolutePath).catch(() => null);
    if (!canonicalPath || !isWithin(canonicalRoot, canonicalPath)) {
      fail(
        "SOURCE_PATH_CHANGED",
        `Selected source path escaped the source root before it could be read: ${relativePath}`,
      );
    }
    const current = await stat(canonicalPath).catch(() => null);
    if (
      !current ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      fail(
        "SOURCE_PATH_CHANGED",
        `Selected source path changed identity before it could be read: ${relativePath}`,
      );
    }

    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      fail(
        "SOURCE_FILE_CHANGED",
        `Selected source file changed while it was being read: ${relativePath}`,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function inspectOutput(absoluteRoot, canonicalRoot, output) {
  const requested = path.resolve(output);
  const requestedParent = path.dirname(requested);
  const parentInfo = await lstat(requestedParent).catch(() => null);
  if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) {
    fail("OUTPUT_PARENT_INVALID", "Context output parent must be an existing real directory.");
  }
  const canonicalParent = await realpath(requestedParent);
  const target = path.join(canonicalParent, path.basename(requested));
  if (
    isWithin(absoluteRoot, requested) ||
    isWithin(canonicalRoot, target)
  ) {
    fail("OUTPUT_CONFINEMENT_INVALID", "Context output must be outside the source root.");
  }
  if (await lstat(target).then(() => true, () => false)) {
    fail("OUTPUT_EXISTS", `Context output already exists: ${target}`);
  }
  const parentIdentity = await stat(canonicalParent);
  return {
    target,
    parent: canonicalParent,
    parentIdentity: { dev: parentIdentity.dev, ino: parentIdentity.ino },
  };
}

export async function atomicWrite(target, contents, expectedParent) {
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  try {
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const currentParent = await stat(expectedParent.parent);
    if (
      currentParent.dev !== expectedParent.parentIdentity.dev ||
      currentParent.ino !== expectedParent.parentIdentity.ino
    ) {
      fail("OUTPUT_PARENT_CHANGED", "Context output parent identity changed before creation.");
    }
    await link(temporary, target).catch((error) => {
      if (error.code === "EEXIST") {
        fail("OUTPUT_EXISTS", `Context output already exists: ${target}`);
      }
      throw error;
    });
    await chmod(target, 0o600);
    const directory = await open(path.dirname(target), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function resolveSourceRoot(root) {
  const absoluteRoot = path.resolve(root);
  const rootInfo = await lstat(absoluteRoot).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    fail("ROOT_INVALID", `Root must be a real directory: ${absoluteRoot}`);
  }
  return {
    absoluteRoot,
    canonicalRoot: await realpath(absoluteRoot),
  };
}

async function buildPackedContextArtifact({
  source,
  includes,
  testMode,
  maxFileBytes,
  maxTotalBytes,
  maxFiles,
  maxArtifactBytes,
  testHooks,
}) {
  const { absoluteRoot, canonicalRoot } = source;
  const normalized = await validateIncludes(canonicalRoot, includes, { filesOnly: true });
  const selected = new Set();
  for (const relativePath of normalized) {
    await collect(canonicalRoot, relativePath, selected);
  }

  const paths = [...selected].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  );
  if (paths.length > maxFiles) {
    fail("TOO_MANY_FILES", `Selected files exceed the ${maxFiles} file limit.`);
  }
  if (testHooks !== null && !testMode) {
    fail("TEST_HOOKS_FORBIDDEN", "Packing test hooks require explicit test mode.");
  }
  if (testHooks?.afterSelection !== undefined) {
    if (typeof testHooks.afterSelection !== "function") {
      fail("TEST_HOOK_INVALID", "afterSelection must be a function.");
    }
    await testHooks.afterSelection();
  }
  const files = [];
  let sourceBytes = 0;
  for (const relativePath of paths) {
    const bytes = await readSelectedFile(canonicalRoot, relativePath);
    if (bytes.byteLength > maxFileBytes) {
      fail("FILE_TOO_LARGE", `File exceeds ${maxFileBytes} bytes: ${relativePath}`);
    }
    sourceBytes += bytes.byteLength;
    if (sourceBytes > maxTotalBytes) {
      fail("PAYLOAD_TOO_LARGE", `Selected files exceed ${maxTotalBytes} bytes.`);
    }
    files.push({
      path: relativePath,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      content: decodeUtf8(bytes, relativePath),
    });
  }

  const artifact = {
    kind: "COLLAB_CONTEXT_V1",
    protocolVersion: 1,
    rootLabel: path.basename(absoluteRoot),
    files,
  };
  const bytes = Buffer.from(`${JSON.stringify(artifact)}\n`);
  if (bytes.byteLength > maxArtifactBytes) {
    fail("ARTIFACT_TOO_LARGE", `Serialized artifact exceeds ${maxArtifactBytes} bytes.`);
  }
  return {
    absoluteRoot,
    canonicalRoot,
    bytes,
    size: bytes.byteLength,
    sha256: sha256(bytes),
    sourceBytes,
    files: files.map(({ path: filePath, bytes: fileBytes, sha256: digest }) => ({
      path: filePath,
      bytes: fileBytes,
      sha256: digest,
    })),
  };
}

export async function buildPackedContext({
  root,
  includes,
  testMode = false,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  maxArtifactBytes = LIMITS_V1.pack.maxArtifactBytes,
  testHooks = null,
}) {
  const source = await resolveSourceRoot(root);
  return buildPackedContextArtifact({
    source,
    includes,
    testMode,
    maxFileBytes,
    maxTotalBytes,
    maxFiles,
    maxArtifactBytes,
    testHooks,
  });
}

export async function packContext({
  root,
  includes,
  output,
  scanner = "gitleaks",
  testMode = false,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  maxArtifactBytes = LIMITS_V1.pack.maxArtifactBytes,
  testHooks = null,
}) {
  const source = await resolveSourceRoot(root);
  const outputInfo = await inspectOutput(
    source.absoluteRoot,
    source.canonicalRoot,
    output,
  );
  const packed = await buildPackedContextArtifact({
    source,
    includes,
    testMode,
    maxFileBytes,
    maxTotalBytes,
    maxFiles,
    maxArtifactBytes,
    testHooks,
  });
  const artifactPath = outputInfo.target;

  const staging = await mkdtemp(path.join(os.tmpdir(), "codex-chat-scan-"));
  try {
    await writeFile(path.join(staging, "context.json"), packed.bytes, {
      mode: 0o600,
    });
    var scan = await scanDirectory(staging, scanner, { testMode });
    await atomicWrite(artifactPath, packed.bytes, outputInfo);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  return {
    artifactPath,
    size: packed.size,
    sha256: packed.sha256,
    sourceBytes: packed.sourceBytes,
    files: packed.files,
    scanner: scan,
  };
}
