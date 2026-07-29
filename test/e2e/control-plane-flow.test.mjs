import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { cliPath, runCli, tempDir } from "../helpers.mjs";

function firstLine(stream) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const onData = (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      resolve(buffered.slice(0, newline));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("control-plane process ended before readiness"));
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
    };
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

test("control-plane CLI serves remote coordination and shuts down cleanly", async (t) => {
  const stateDir = await tempDir("codex-chat-control-e2e-");
  const token = "e2e-control-token-with-at-least-32-bytes";
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "control-serve",
      "--state-dir", stateDir,
      "--host", "127.0.0.1",
      "--port", "0",
    ],
    {
      env: {
        ...process.env,
        CODEX_CHAT_CONTROL_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stopped = false;
  t.after(async () => {
    if (stopped) return;
    child.kill("SIGTERM");
    await once(child, "exit");
  });
  const readiness = JSON.parse(await firstLine(child.stdout));
  assert.equal(readiness.ok, true);
  assert.equal(readiness.command, "control-serve");
  assert.equal(readiness.data.tls, false);
  assert.equal(JSON.stringify(readiness).includes(token), false);

  const queried = await runCli(
    [
      "control",
      "--endpoint", readiness.data.endpoint,
      "--request-json",
      JSON.stringify({
        operation: "run.read",
        data: {
          workspaceId: "workspace-e2e-control",
          runId: "run-e2e-control",
        },
      }),
    ],
    {
      env: {
        CODEX_CHAT_CONTROL_TOKEN: token,
      },
    },
  );
  assert.equal(queried.code, 0, JSON.stringify(queried.json));
  assert.equal(queried.json.data.result, null);

  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");
  stopped = true;
  assert.equal(code, 0);
  assert.equal(signal, null);
});
