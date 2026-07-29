import { chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fail } from "./errors.mjs";
import { inspectScanner } from "./scanner.mjs";

export const PROTOCOL_VERSION = 1;

export const AUTHORITY = Object.freeze({
  externalEgress: true,
  mutateLocal: true,
  commit: false,
  push: false,
  publish: false,
  deploy: false,
  paidApiFallback: false,
});

export function validateRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) {
    fail("PATH_INVALID", "Path must be a non-empty string.");
  }
  if (value.includes("\\")) {
    fail("PATH_BACKSLASH", `Backslashes are not allowed in collaboration paths: ${value}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    fail("PATH_CONTROL", "Control characters are not allowed in collaboration paths.");
  }
  if (path.isAbsolute(value)) {
    fail("PATH_ABSOLUTE", `Path must be relative: ${value}`);
  }
  const unicodeNormalized = value.normalize("NFC");
  const segments = unicodeNormalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("PATH_TRAVERSAL", `Path is not canonical relative POSIX form: ${value}`);
  }
  const normalized = path.posix.normalize(unicodeNormalized);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    fail("PATH_TRAVERSAL", `Path escapes the selected root: ${value}`);
  }
  return normalized;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export async function validateIncludes(root, includes, { filesOnly = false } = {}) {
  if (!Array.isArray(includes) || includes.length === 0) {
    fail("INCLUDE_REQUIRED", "At least one --include path is required.");
  }
  const normalized = [...new Set(includes.map(validateRelativePath))].sort(compareUtf8);
  const collisionKeys = new Map();
  for (const relativePath of normalized) {
    const collisionKey = relativePath.normalize("NFC").toLocaleLowerCase("en-US");
    const existing = collisionKeys.get(collisionKey);
    if (existing && existing !== relativePath) {
      fail("PATH_COLLISION", `Paths collide by case or Unicode normalization: ${existing}, ${relativePath}`);
    }
    collisionKeys.set(collisionKey, relativePath);
  }
  for (const relativePath of normalized) {
    let componentPath = root;
    for (const segment of relativePath.split("/")) {
      componentPath = path.join(componentPath, segment);
      const component = await lstat(componentPath).catch(() => null);
      if (component?.isSymbolicLink()) {
        fail("SYMLINK_REJECTED", `Path crosses a symbolic link: ${relativePath}`);
      }
    }
    const target = path.join(root, relativePath);
    let info;
    try {
      info = await lstat(target);
    } catch {
      fail("PATH_MISSING", `Included path does not exist: ${relativePath}`);
    }
    if (info.isSymbolicLink()) {
      fail("SYMLINK_REJECTED", `Symbolic links are not allowed: ${relativePath}`);
    }
    if (!info.isFile() && !info.isDirectory()) {
      fail("PATH_TYPE_REJECTED", `Unsupported included path: ${relativePath}`);
    }
    if (filesOnly && !info.isFile()) {
      fail("EXPLICIT_FILE_REQUIRED", `MVP packing accepts explicit files only: ${relativePath}`);
    }
  }
  return normalized;
}

export async function preflight({
  root,
  stateDir,
  includes,
  scanner = "gitleaks",
  testMode = false,
}) {
  const absoluteRoot = path.resolve(root);
  const absoluteStateDir = path.resolve(stateDir);
  const rootInfo = await lstat(absoluteRoot).catch(() => null);
  if (!rootInfo?.isDirectory()) {
    fail("ROOT_INVALID", `Root is not a directory: ${absoluteRoot}`);
  }
  const include = await validateIncludes(absoluteRoot, includes, {
    filesOnly: true,
  });

  await mkdir(absoluteStateDir, { recursive: true, mode: 0o700 });
  const stateInfo = await lstat(absoluteStateDir).catch(() => null);
  if (!stateInfo?.isDirectory() || stateInfo.isSymbolicLink()) {
    fail("STATE_DIR_INVALID", `State directory must be a real directory: ${absoluteStateDir}`);
  }
  await chmod(absoluteStateDir, 0o700);
  const scannerInfo = await inspectScanner(scanner, { testMode });

  const gitDir = path.join(absoluteRoot, ".git");
  const hasGit = await lstat(gitDir).then(() => true, () => false);
  let vcs = { kind: "none", ref: null, dirty: null };
  if (hasGit) {
    const ref = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: absoluteRoot,
      encoding: "utf8",
      shell: false,
    });
    const status = spawnSync("git", ["status", "--porcelain=v1"], {
      cwd: absoluteRoot,
      encoding: "utf8",
      shell: false,
    });
    vcs = {
      kind: "git",
      ref: ref.status === 0 ? ref.stdout.trim() : null,
      dirty: status.status === 0 ? status.stdout.length > 0 : null,
    };
  }

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    command: "preflight",
    root: absoluteRoot,
    vcs,
    include,
    scanner: {
      ...scannerInfo,
      available: scannerInfo.mode !== "skip",
    },
    stateDir: absoluteStateDir,
    authority: AUTHORITY,
  };
}
