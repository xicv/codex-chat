import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  synchronizeLocalInstall,
} from "../../scripts/sync-local-install.mjs";
import { tempDir, writeFixture } from "../helpers.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function git(repoRoot, ...args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.trim();
}

async function createRepository(t, { includeHooks = false } = {}) {
  const rawRoot = await tempDir("codex-chat-local-sync-repo-");
  const repoRoot = await realpath(rawRoot);
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await git(repoRoot, "init", "-b", "main");
  await git(repoRoot, "config", "user.name", "Codex Chat Test");
  await git(repoRoot, "config", "user.email", "codex-chat@example.invalid");
  const skillRoot = path.join(repoRoot, ".agents/skills/codex-chat");
  await writeFixture(
    skillRoot,
    "SKILL.md",
    "---\nname: codex-chat\ndescription: test\n---\n\nversion one\n",
  );
  const cliSource = await writeFixture(
    skillRoot,
    "scripts/codex-chat.mjs",
    "#!/usr/bin/env node\nprocess.stdout.write(\"version-one\\n\");\n",
  );
  await chmod(cliSource, 0o755);
  if (includeHooks) {
    await mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await mkdir(path.join(repoRoot, ".githooks"), { recursive: true });
    await copyFile(
      path.join(projectRoot, "scripts/sync-local-install.mjs"),
      path.join(repoRoot, "scripts/sync-local-install.mjs"),
    );
    await copyFile(
      path.join(projectRoot, ".githooks/reference-transaction"),
      path.join(repoRoot, ".githooks/reference-transaction"),
    );
    await copyFile(
      path.join(projectRoot, ".githooks/pre-push"),
      path.join(repoRoot, ".githooks/pre-push"),
    );
    await chmod(path.join(repoRoot, "scripts/sync-local-install.mjs"), 0o755);
    await chmod(path.join(repoRoot, ".githooks/reference-transaction"), 0o755);
    await chmod(path.join(repoRoot, ".githooks/pre-push"), 0o755);
  }
  await git(repoRoot, "add", ".");
  await git(repoRoot, "commit", "-m", "Initial skill");
  const targetRoot = await realpath(
    await tempDir("codex-chat-local-sync-target-"),
  );
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  return {
    repoRoot,
    skillRoot,
    installDir: path.join(targetRoot, "skills", "codex-chat"),
    cliPath: path.join(targetRoot, "bin", "codex-chat"),
  };
}

test("local sync installs only exact committed main bytes and repairs drift", async (t) => {
  const fixture = await createRepository(t);
  const before = await synchronizeLocalInstall({ ...fixture, check: true });
  assert.equal(before.ok, false);
  assert.deepEqual(
    await readdir(path.dirname(path.dirname(fixture.installDir))),
    [],
  );
  const first = await synchronizeLocalInstall(fixture);
  assert.equal(first.ok, true);
  assert.equal(first.action, "synchronized");
  assert.match(
    await readFile(path.join(fixture.installDir, "SKILL.md"), "utf8"),
    /version one/,
  );
  assert.equal(
    path.resolve(path.dirname(fixture.cliPath), await readlink(fixture.cliPath)),
    path.join(fixture.installDir, "scripts/codex-chat.mjs"),
  );

  await writeFile(
    path.join(fixture.skillRoot, "SKILL.md"),
    "dirty working-tree content\n",
  );
  const unchanged = await synchronizeLocalInstall(fixture);
  assert.equal(unchanged.action, "unchanged");
  assert.match(
    await readFile(path.join(fixture.installDir, "SKILL.md"), "utf8"),
    /version one/,
  );

  await writeFile(path.join(fixture.installDir, "unexpected.txt"), "drift\n");
  const stale = await synchronizeLocalInstall({ ...fixture, check: true });
  assert.equal(stale.ok, false);
  assert.equal(stale.skillCurrent, false);
  const repaired = await synchronizeLocalInstall(fixture);
  assert.equal(repaired.action, "synchronized");
  await assert.rejects(
    readFile(path.join(fixture.installDir, "unexpected.txt")),
    (error) => error.code === "ENOENT",
  );
});

test("local sync rejects non-main sources, symlinked targets, and CLI conflicts", async (t) => {
  const fixture = await createRepository(t);
  const initialMain = await git(fixture.repoRoot, "rev-parse", "refs/heads/main");
  await writeFile(
    path.join(fixture.skillRoot, "SKILL.md"),
    "---\nname: codex-chat\ndescription: test\n---\n\nversion two\n",
  );
  await git(fixture.repoRoot, "add", ".agents/skills/codex-chat/SKILL.md");
  await git(fixture.repoRoot, "commit", "-m", "Advance main");
  await assert.rejects(
    synchronizeLocalInstall({ ...fixture, commit: initialMain }),
    (error) => error.code === "LOCAL_INSTALL_NOT_MAIN",
  );

  await mkdir(path.dirname(fixture.cliPath), { recursive: true });
  await writeFile(fixture.cliPath, "unmanaged command\n");
  await assert.rejects(
    synchronizeLocalInstall(fixture),
    (error) => error.code === "LOCAL_CLI_CONFLICT",
  );
  await assert.rejects(
    readFile(path.join(fixture.installDir, "SKILL.md")),
    (error) => error.code === "ENOENT",
  );
  await rm(fixture.cliPath);

  const outside = path.join(path.dirname(fixture.installDir), "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "sentinel.txt"), "preserve\n");
  await symlink(outside, fixture.installDir, "dir");
  await assert.rejects(
    synchronizeLocalInstall(fixture),
    (error) => error.code === "LOCAL_INSTALL_TARGET_INVALID",
  );
  assert.equal(
    await readFile(path.join(outside, "sentinel.txt"), "utf8"),
    "preserve\n",
  );
});

test("main reference and push hooks keep the personal skill and CLI current", async (t) => {
  const fixture = await createRepository(t, { includeHooks: true });
  const installed = await synchronizeLocalInstall({
    ...fixture,
    installHook: true,
  });
  assert.equal(installed.hookCurrent, true);
  assert.equal(
    await git(fixture.repoRoot, "config", "--local", "--get", "core.hooksPath"),
    path.join(fixture.repoRoot, ".githooks"),
  );

  await writeFile(
    path.join(fixture.skillRoot, "SKILL.md"),
    "---\nname: codex-chat\ndescription: test\n---\n\nversion two\n",
  );
  await writeFile(
    path.join(fixture.skillRoot, "scripts/codex-chat.mjs"),
    "#!/usr/bin/env node\nprocess.stdout.write(\"version-two\\n\");\n",
  );
  await chmod(
    path.join(fixture.skillRoot, "scripts/codex-chat.mjs"),
    0o755,
  );
  await git(fixture.repoRoot, "add", ".agents/skills/codex-chat");
  await git(fixture.repoRoot, "commit", "-m", "Update main skill");
  assert.match(
    await readFile(path.join(fixture.installDir, "SKILL.md"), "utf8"),
    /version two/,
  );
  const { stdout } = await execFileAsync(fixture.cliPath, [], {
    encoding: "utf8",
  });
  assert.equal(stdout, "version-two\n");

  await writeFile(path.join(fixture.installDir, "push-drift.txt"), "drift\n");
  const remoteRoot = await realpath(
    await tempDir("codex-chat-local-sync-remote-"),
  );
  t.after(() => rm(remoteRoot, { recursive: true, force: true }));
  await git(remoteRoot, "init", "--bare");
  await git(fixture.repoRoot, "remote", "add", "origin", remoteRoot);
  await git(fixture.repoRoot, "push", "origin", "main");
  await assert.rejects(
    readFile(path.join(fixture.installDir, "push-drift.txt")),
    (error) => error.code === "ENOENT",
  );
  assert.equal(
    await git(fixture.repoRoot, "rev-parse", "refs/heads/main"),
    await git(remoteRoot, "rev-parse", "refs/heads/main"),
  );

  const secondaryParent = await realpath(
    await tempDir("codex-chat-local-sync-secondary-"),
  );
  t.after(() => rm(secondaryParent, { recursive: true, force: true }));
  const secondaryRoot = path.join(secondaryParent, "clone");
  await git(
    secondaryParent,
    "clone",
    "--branch",
    "main",
    remoteRoot,
    secondaryRoot,
  );
  await git(secondaryRoot, "config", "user.name", "Codex Chat Test");
  await git(
    secondaryRoot,
    "config",
    "user.email",
    "codex-chat@example.invalid",
  );
  await writeFile(
    path.join(secondaryRoot, ".agents/skills/codex-chat/SKILL.md"),
    "---\nname: codex-chat\ndescription: test\n---\n\nversion three\n",
  );
  await writeFile(
    path.join(
      secondaryRoot,
      ".agents/skills/codex-chat/scripts/codex-chat.mjs",
    ),
    "#!/usr/bin/env node\nprocess.stdout.write(\"version-three\\n\");\n",
  );
  await git(secondaryRoot, "add", ".agents/skills/codex-chat");
  await git(secondaryRoot, "commit", "-m", "Advance remote main");
  await git(secondaryRoot, "push", "origin", "main");
  await git(fixture.repoRoot, "pull", "--ff-only", "origin", "main");
  assert.match(
    await readFile(path.join(fixture.installDir, "SKILL.md"), "utf8"),
    /version three/,
  );
  const refreshed = await execFileAsync(fixture.cliPath, [], {
    encoding: "utf8",
  });
  assert.equal(refreshed.stdout, "version-three\n");

  const current = await synchronizeLocalInstall({
    ...fixture,
    check: true,
    installHook: true,
  });
  assert.equal(current.ok, true);
});
