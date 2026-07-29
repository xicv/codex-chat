import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, symlink } from "node:fs/promises";
import { tempDir, writeFixture, runCli } from "../helpers.mjs";

test("preflight emits a stable JSON contract without initializing Git", async () => {
  const root = await tempDir();
  const stateDir = path.join(root, ".state");
  await writeFixture(root, "src/index.js", "export const answer = 42;\n");

  const result = await runCli([
    "preflight",
    "--root",
    root,
    "--state-dir",
    stateDir,
    "--include",
    "src/index.js",
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual({
    ...result.json,
    data: {
      ...result.json.data,
      scanner: {
        mode: result.json.data.scanner.mode,
        available: result.json.data.scanner.available,
      },
    },
  }, {
    schema: "codex-chat/cli/v1",
    ok: true,
    protocolVersion: 1,
    stateVersion: 1,
    command: "preflight",
    data: {
      ok: true,
      protocolVersion: 1,
      command: "preflight",
      root,
      vcs: { kind: "none", ref: null, dirty: null },
      include: ["src/index.js"],
      scanner: { mode: "gitleaks", available: true },
      stateDir,
      authority: {
        externalEgress: true,
        mutateLocal: true,
        commit: false,
        push: false,
        publish: false,
        deploy: false,
        paidApiFallback: false,
      },
    },
  });
  assert.match(result.json.data.scanner.executable, /gitleaks$/);
  assert.match(result.json.data.scanner.version, /^\d+\.\d+\.\d+/);
  assert.equal(await import("node:fs/promises").then(({ stat }) =>
    stat(path.join(root, ".git")).then(() => true, () => false)), false);
});

test("preflight rejects a symlinked state directory", async () => {
  const root = await tempDir();
  await writeFixture(root, "source.txt", "safe\n");
  const realState = path.join(root, "real-state");
  const linkedState = path.join(root, "linked-state");
  await mkdir(realState);
  await symlink(realState, linkedState);

  const result = await runCli([
    "preflight", "--root", root, "--include", "source.txt",
    "--state-dir", linkedState,
  ]);
  assert.equal(result.code, 2);
  assert.equal(result.json.error.code, "STATE_DIR_INVALID");
});
