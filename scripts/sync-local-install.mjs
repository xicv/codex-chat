#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const SKILL_PREFIX = ".agents/skills/codex-chat";
const MAX_FILES = 256;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_REPOSITORY_PATH = /^[A-Za-z0-9._/-]+$/;

class LocalInstallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalInstallError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LocalInstallError(code, message);
}

async function runGit(repoRoot, args, {
  encoding = "utf8",
  maxBuffer = 2 * 1024 * 1024,
} = {}) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      encoding,
      maxBuffer,
    });
    return stdout;
  } catch {
    fail(
      "LOCAL_INSTALL_GIT_FAILED",
      `Git command failed: git ${args[0] ?? ""}.`,
    );
  }
}

async function readLocalConfig(repoRoot, key) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["config", "--local", "--get", key],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
      },
    );
    return stdout.trim() || null;
  } catch (error) {
    if (error.code === 1) return null;
    fail(
      "LOCAL_INSTALL_GIT_FAILED",
      `Unable to read local Git configuration: ${key}.`,
    );
  }
}

async function writeLocalConfig(repoRoot, key, value) {
  await runGit(repoRoot, ["config", "--local", key, value]);
}

async function normalizeRepoRoot(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("LOCAL_INSTALL_REPOSITORY_INVALID", "Repository root is invalid.");
  }
  const root = await realpath(path.resolve(value)).catch(() => null);
  if (!root) {
    fail("LOCAL_INSTALL_REPOSITORY_INVALID", "Repository root does not exist.");
  }
  const discovered = (
    await runGit(root, ["rev-parse", "--show-toplevel"])
  ).trim();
  const canonicalDiscovered = await realpath(discovered).catch(() => null);
  if (canonicalDiscovered !== root) {
    fail(
      "LOCAL_INSTALL_REPOSITORY_INVALID",
      "Sync must run against the codex-chat repository root.",
    );
  }
  return root;
}

function validateAbsoluteTarget(value, basename, label) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    path.basename(value) !== basename
  ) {
    fail(
      "LOCAL_INSTALL_TARGET_INVALID",
      `${label} must be an absolute path ending in ${basename}.`,
    );
  }
  return path.normalize(value);
}

async function configuredTarget(repoRoot, option, key, fallback, basename, label) {
  const configured = option ?? await readLocalConfig(repoRoot, key) ?? fallback;
  return validateAbsoluteTarget(configured, basename, label);
}

async function canonicalParent(target, { create = false } = {}) {
  const parent = path.dirname(target);
  if (create) {
    await mkdir(parent, { recursive: true, mode: 0o700 });
  }
  const canonical = await realpath(parent).catch((error) => {
    if (!create && error.code === "ENOENT") return null;
    throw error;
  });
  if (canonical === null) return false;
  if (canonical !== parent) {
    fail(
      "LOCAL_INSTALL_TARGET_INVALID",
      `Target parent must not traverse symbolic links: ${parent}`,
    );
  }
  return true;
}

function splitNul(buffer) {
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    records.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start !== buffer.length) {
    fail(
      "LOCAL_INSTALL_TREE_INVALID",
      "Git tree output was not NUL terminated.",
    );
  }
  return records;
}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail("LOCAL_INSTALL_TREE_INVALID", `${label} is not valid UTF-8.`);
  }
}

async function resolveMainCommit(repoRoot, commitish = "refs/heads/main") {
  if (commitish !== "refs/heads/main" && !OBJECT_ID.test(commitish)) {
    fail(
      "LOCAL_INSTALL_COMMIT_INVALID",
      "Commit must be refs/heads/main or a full object ID.",
    );
  }
  const commit = (
    await runGit(repoRoot, [
      "rev-parse",
      "--verify",
      `${commitish}^{commit}`,
    ])
  ).trim();
  const main = (
    await runGit(repoRoot, [
      "rev-parse",
      "--verify",
      "refs/heads/main^{commit}",
    ])
  ).trim();
  if (!OBJECT_ID.test(commit) || commit !== main) {
    fail(
      "LOCAL_INSTALL_NOT_MAIN",
      "Local installation may only synchronize from the exact local main commit.",
    );
  }
  return commit;
}

async function readCommittedSkill(repoRoot, commit) {
  const rawTree = await runGit(
    repoRoot,
    ["ls-tree", "-rz", "--full-tree", commit, "--", SKILL_PREFIX],
    {
      encoding: "buffer",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const records = splitNul(rawTree);
  if (records.length === 0 || records.length > MAX_FILES) {
    fail(
      "LOCAL_INSTALL_TREE_INVALID",
      "Committed skill file count is empty or exceeds its safety limit.",
    );
  }
  const entries = [];
  let totalBytes = 0;
  for (const rawRecord of records) {
    const record = decodeUtf8(rawRecord, "Git tree record");
    const separator = record.indexOf("\t");
    const header = record.slice(0, separator).split(" ");
    const repositoryPath = record.slice(separator + 1);
    if (
      separator < 0 ||
      header.length !== 3 ||
      !["100644", "100755"].includes(header[0]) ||
      header[1] !== "blob" ||
      !OBJECT_ID.test(header[2]) ||
      !repositoryPath.startsWith(`${SKILL_PREFIX}/`) ||
      !SAFE_REPOSITORY_PATH.test(repositoryPath)
    ) {
      fail(
        "LOCAL_INSTALL_TREE_INVALID",
        "Committed skill contains an unsupported entry.",
      );
    }
    const relativePath = path.posix.relative(SKILL_PREFIX, repositoryPath);
    if (
      relativePath.length === 0 ||
      relativePath.startsWith("../") ||
      path.posix.isAbsolute(relativePath)
    ) {
      fail(
        "LOCAL_INSTALL_TREE_INVALID",
        "Committed skill path escapes its installation root.",
      );
    }
    const bytes = await runGit(
      repoRoot,
      ["cat-file", "blob", header[2]],
      {
        encoding: "buffer",
        maxBuffer: MAX_FILE_BYTES + 1024,
      },
    );
    if (bytes.byteLength > MAX_FILE_BYTES) {
      fail(
        "LOCAL_INSTALL_TREE_INVALID",
        `Committed skill file exceeds ${MAX_FILE_BYTES} bytes.`,
      );
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      fail(
        "LOCAL_INSTALL_TREE_INVALID",
        `Committed skill exceeds ${MAX_TOTAL_BYTES} bytes.`,
      );
    }
    entries.push({
      relativePath,
      executable: header[0] === "100755",
      bytes,
    });
  }
  if (!entries.some((entry) => entry.relativePath === "SKILL.md")) {
    fail("LOCAL_INSTALL_TREE_INVALID", "Committed skill lacks SKILL.md.");
  }
  const tree = (
    await runGit(
      repoRoot,
      ["rev-parse", "--verify", `${commit}:${SKILL_PREFIX}`],
    )
  ).trim();
  if (!OBJECT_ID.test(tree)) {
    fail("LOCAL_INSTALL_TREE_INVALID", "Committed skill tree ID is invalid.");
  }
  return { entries, tree };
}

async function pathInfo(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function installedFiles(root, current = "", files = []) {
  const directory = path.join(root, current);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = current
      ? path.posix.join(current, entry.name)
      : entry.name;
    const fullPath = path.join(root, relativePath);
    if (entry.isSymbolicLink()) {
      fail(
        "LOCAL_INSTALL_TARGET_INVALID",
        "Installed skill must not contain symbolic links.",
      );
    }
    if (entry.isDirectory()) {
      await installedFiles(root, relativePath, files);
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      fail(
        "LOCAL_INSTALL_TARGET_INVALID",
        "Installed skill contains an unsupported filesystem entry.",
      );
    }
  }
  return files;
}

async function skillMatches(installDir, expectedEntries) {
  const info = await pathInfo(installDir);
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(
      "LOCAL_INSTALL_TARGET_INVALID",
      "Installed skill target must be a real directory.",
    );
  }
  const expected = new Map(
    expectedEntries.map((entry) => [entry.relativePath, entry]),
  );
  const observed = await installedFiles(installDir);
  if (
    observed.length !== expected.size ||
    observed.some((relativePath) => !expected.has(relativePath))
  ) {
    return false;
  }
  for (const [relativePath, entry] of expected) {
    const fullPath = path.join(installDir, relativePath);
    const fileInfo = await lstat(fullPath);
    const executable = (fileInfo.mode & 0o111) !== 0;
    if (
      !fileInfo.isFile() ||
      executable !== entry.executable ||
      !(await readFile(fullPath)).equals(entry.bytes)
    ) {
      return false;
    }
  }
  return true;
}

async function validateCliPath(cliPath, expectedTarget) {
  const info = await pathInfo(cliPath);
  if (!info) return { matches: false, missing: true };
  if (!info.isSymbolicLink()) {
    fail(
      "LOCAL_CLI_CONFLICT",
      "CLI path exists and is not a managed symbolic link.",
    );
  }
  const linked = await readlink(cliPath);
  return {
    matches: path.resolve(path.dirname(cliPath), linked) === expectedTarget,
    missing: false,
  };
}

async function writeSkillTree(parent, entries) {
  const temporary = await mkdtemp(path.join(parent, ".codex-chat-sync-"));
  await chmod(temporary, 0o700);
  try {
    for (const entry of entries) {
      const destination = path.join(temporary, entry.relativePath);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, entry.bytes, {
        flag: "wx",
        mode: entry.executable ? 0o755 : 0o644,
      });
      await chmod(destination, entry.executable ? 0o755 : 0o644);
    }
    return temporary;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function replaceSkill(installDir, entries, createCli) {
  const parent = path.dirname(installDir);
  const temporary = await writeSkillTree(parent, entries);
  const backup = path.join(
    parent,
    `.codex-chat-backup-${process.pid}-${randomUUID()}`,
  );
  const current = await pathInfo(installDir);
  let backedUp = false;
  let installed = false;
  try {
    if (current) {
      await rename(installDir, backup);
      backedUp = true;
    }
    await rename(temporary, installDir);
    installed = true;
    await createCli();
    if (backedUp) {
      await rm(backup, { recursive: true, force: true });
      backedUp = false;
    }
  } catch (error) {
    if (installed) {
      await rename(installDir, temporary).catch(() => {});
      installed = false;
    }
    if (backedUp) {
      await rename(backup, installDir).catch(() => {});
      backedUp = false;
    }
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (backedUp) {
      await rm(backup, { recursive: true, force: true });
    }
  }
}

async function hookConfigurationMatches(repoRoot, installDir, cliPath) {
  const expectedHooks = path.join(repoRoot, ".githooks");
  const configuredHooks = await readLocalConfig(repoRoot, "core.hooksPath");
  const configuredInstall = await readLocalConfig(
    repoRoot,
    "codexChat.installDir",
  );
  const configuredCli = await readLocalConfig(repoRoot, "codexChat.binPath");
  if (
    configuredHooks !== expectedHooks ||
    configuredInstall !== installDir ||
    configuredCli !== cliPath
  ) {
    return false;
  }
  for (const name of ["reference-transaction", "pre-push"]) {
    const info = await pathInfo(path.join(expectedHooks, name));
    if (!info?.isFile() || (info.mode & 0o111) === 0) return false;
  }
  return true;
}

async function installHookConfiguration(repoRoot, installDir, cliPath) {
  const expectedHooks = path.join(repoRoot, ".githooks");
  const current = await readLocalConfig(repoRoot, "core.hooksPath");
  if (
    current !== null &&
    path.resolve(repoRoot, current) !== expectedHooks
  ) {
    fail(
      "LOCAL_INSTALL_HOOK_CONFLICT",
      "Repository already uses a different core.hooksPath.",
    );
  }
  for (const name of ["reference-transaction", "pre-push"]) {
    const hookPath = path.join(expectedHooks, name);
    const info = await pathInfo(hookPath);
    if (!info?.isFile() || (info.mode & 0o111) === 0) {
      fail(
        "LOCAL_INSTALL_HOOK_INVALID",
        `Required Git hook is missing or not executable: ${name}.`,
      );
    }
  }
  await writeLocalConfig(repoRoot, "core.hooksPath", expectedHooks);
  await writeLocalConfig(repoRoot, "codexChat.installDir", installDir);
  await writeLocalConfig(repoRoot, "codexChat.binPath", cliPath);
}

export async function synchronizeLocalInstall({
  repoRoot: repoRootValue = DEFAULT_REPO_ROOT,
  commit: commitish = "refs/heads/main",
  installDir: installDirOption,
  cliPath: cliPathOption,
  check = false,
  installHook = false,
} = {}) {
  const repoRoot = await normalizeRepoRoot(repoRootValue);
  const installDir = await configuredTarget(
    repoRoot,
    installDirOption,
    "codexChat.installDir",
    path.join(os.homedir(), ".codex", "skills", "codex-chat"),
    "codex-chat",
    "Skill installation path",
  );
  const cliPath = await configuredTarget(
    repoRoot,
    cliPathOption,
    "codexChat.binPath",
    path.join(os.homedir(), ".local", "bin", "codex-chat"),
    "codex-chat",
    "CLI installation path",
  );
  await canonicalParent(installDir, { create: !check });
  await canonicalParent(cliPath, { create: !check });
  const commit = await resolveMainCommit(repoRoot, commitish);
  const { entries, tree } = await readCommittedSkill(repoRoot, commit);
  const expectedCli = path.join(
    installDir,
    "scripts",
    "codex-chat.mjs",
  );
  const cli = await validateCliPath(cliPath, expectedCli);
  const skillCurrent = await skillMatches(installDir, entries);
  const hookCurrent = installHook
    ? await hookConfigurationMatches(repoRoot, installDir, cliPath)
    : true;

  if (check) {
    const upToDate = skillCurrent && cli.matches && hookCurrent;
    return {
      schema: "codex-chat/local-install/v1",
      ok: upToDate,
      action: "checked",
      commit,
      tree,
      skillCurrent,
      cliCurrent: cli.matches,
      hookCurrent,
      installDir,
      cliPath,
    };
  }

  const createCli = async () => {
    if (cli.matches) return;
    if (!cli.missing) {
      fail(
        "LOCAL_CLI_CONFLICT",
        "CLI symbolic link does not target the managed skill installation.",
      );
    }
    await symlink(expectedCli, cliPath, "file");
  };
  if (!skillCurrent) {
    await replaceSkill(installDir, entries, createCli);
  } else {
    await createCli();
  }
  if (installHook) {
    await installHookConfiguration(repoRoot, installDir, cliPath);
  }
  const verifiedSkill = await skillMatches(installDir, entries);
  const verifiedCli = await validateCliPath(cliPath, expectedCli);
  const verifiedHook = installHook
    ? await hookConfigurationMatches(repoRoot, installDir, cliPath)
    : true;
  if (!verifiedSkill || !verifiedCli.matches || !verifiedHook) {
    fail(
      "LOCAL_INSTALL_VERIFICATION_FAILED",
      "Local skill, CLI, or hook verification failed after synchronization.",
    );
  }
  return {
    schema: "codex-chat/local-install/v1",
    ok: true,
    action: skillCurrent && cli.matches && hookCurrent
      ? "unchanged"
      : "synchronized",
    commit,
    tree,
    skillCurrent: true,
    cliCurrent: true,
    hookCurrent: verifiedHook,
    installDir,
    cliPath,
  };
}

function parseOptions(argv) {
  const options = {};
  const flags = new Set(["check", "install-hook", "quiet"]);
  const valued = new Set(["commit", "install-dir", "bin-path"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      fail("LOCAL_INSTALL_USAGE", `Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    if (flags.has(key)) {
      if (Object.hasOwn(options, key)) {
        fail("LOCAL_INSTALL_USAGE", `Option --${key} may only be used once.`);
      }
      options[key] = true;
      continue;
    }
    if (!valued.has(key)) {
      fail("LOCAL_INSTALL_USAGE", `Unknown option: --${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("LOCAL_INSTALL_USAGE", `Option --${key} requires a value.`);
    }
    if (Object.hasOwn(options, key)) {
      fail("LOCAL_INSTALL_USAGE", `Option --${key} may only be used once.`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const result = await synchronizeLocalInstall({
    commit: options.commit,
    installDir: options["install-dir"],
    cliPath: options["bin-path"],
    check: options.check === true,
    installHook: options["install-hook"] === true,
  });
  if (!options.quiet || !result.ok) {
    const stream = result.ok ? process.stdout : process.stderr;
    stream.write(`${JSON.stringify(result)}\n`);
  }
  if (!result.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const visible = error instanceof LocalInstallError
      ? error
      : new LocalInstallError(
          "LOCAL_INSTALL_INTERNAL",
          "Local skill synchronization failed internally.",
        );
    process.stderr.write(`${JSON.stringify({
      schema: "codex-chat/local-install/v1",
      ok: false,
      error: {
        code: visible.code,
        message: visible.message,
      },
    })}\n`);
    process.exitCode = 1;
  });
}
