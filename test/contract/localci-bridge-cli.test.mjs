import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(
  root,
  ".agents",
  "skills",
  "codex-chat",
  "scripts",
  "localci-bridge.mjs",
);
const baseSha = "d9fe027113486bc31d311d7c7dfffea4749bced4";

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => resolve({ code, output: JSON.parse(stdout) }));
  });
}

test("job-validate emits the codex-chat CLI envelope", async () => {
  const result = await run([
    "job-validate",
    "--file", "test/fixtures/localci-bridge/job.json",
    "--repository", "xicv/PeoplePlanner",
    "--base-sha", baseSha,
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.output.schema, "codex-chat/cli/v1");
  assert.equal(result.output.ok, true);
  assert.equal(result.output.command, "job-validate");
  assert.equal(result.output.data.actionAuthorized, undefined);
});

test("result-validate binds independently supplied head and PR identities", async () => {
  const result = await run([
    "result-validate",
    "--job", "test/fixtures/localci-bridge/job.json",
    "--result", "test/fixtures/localci-bridge/result.json",
    "--repository", "xicv/PeoplePlanner",
    "--base-sha", baseSha,
    "--head-sha", "1".repeat(40),
    "--pr-number", "123",
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.output.data.pullRequestNumber, 123);
  assert.equal(result.output.data.releaseAuthorized, false);
});

test("unknown commands fail closed", async () => {
  const result = await run(["run-shell", "--command", "whoami"]);
  assert.equal(result.code, 2);
  assert.equal(result.output.ok, false);
  assert.equal(result.output.error.code, "UNKNOWN_COMMAND");
});
