import { spawn } from "node:child_process";
import { access, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexChatError, fail } from "./errors.mjs";
import { LIMITS_V1 } from "./limits.mjs";

const {
  maxProcessMs: MAX_PROCESS_MS,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  killGraceMs: KILL_GRACE_MS,
} = LIMITS_V1.scanner;

function scannerEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("GITLEAKS_")) {
      delete environment[key];
    }
  }
  return environment;
}

function run(command, args, {
  cwd,
  timeoutMs = MAX_PROCESS_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(cwd ? { cwd } : {}),
      env: scannerEnvironment(),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputLimited = false;
    let killTimer = null;
    let settled = false;
    function terminate() {
      const signal = (name) => {
        try {
          if (process.platform !== "win32") {
            process.kill(-child.pid, name);
          } else {
            child.kill(name);
          }
        } catch {
          child.kill(name);
        }
      };
      signal("SIGTERM");
      killTimer ??= setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    function collect(target, chunk) {
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes && !outputLimited) {
        outputLimited = true;
        terminate();
      }
    }
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const details = {
        exitCode: code,
        signal,
        outputBytes,
        timeoutMs,
        maxOutputBytes,
      };
      if (outputLimited) {
        reject(new CodexChatError(
          "SCANNER_OUTPUT_LIMIT",
          `Secret scanner output exceeded ${maxOutputBytes} bytes.`,
          details,
        ));
        return;
      }
      if (timedOut) {
        reject(new CodexChatError(
          "SCANNER_TIMEOUT",
          `Secret scanner exceeded ${timeoutMs} ms.`,
          details,
        ));
        return;
      }
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function resolveExecutable(command) {
  const candidates = path.isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    if (await access(candidate, fsConstants.X_OK).then(() => true, () => false)) {
      return realpath(candidate);
    }
  }
  fail("SCANNER_UNAVAILABLE", `Secret scanner is unavailable: ${command}`);
}

export async function inspectScanner(scanner, {
  testMode = false,
  processTimeoutMs = MAX_PROCESS_MS,
  processMaxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  if (
    !testMode &&
    (
      processTimeoutMs !== MAX_PROCESS_MS ||
      processMaxOutputBytes !== MAX_OUTPUT_BYTES
    )
  ) {
    fail(
      "SCANNER_LIMIT_OVERRIDE_FORBIDDEN",
      "Scanner time and output limits are fixed outside test mode.",
    );
  }
  if (scanner === "skip") {
    if (!testMode) {
      fail("SCANNER_BYPASS_FORBIDDEN", "Secret scanning cannot be skipped outside test mode.");
    }
    return { mode: "skip", executable: null, version: null };
  }

  const executable = await resolveExecutable(scanner);
  let versionResult;
  try {
    versionResult = await run(executable, ["version"], {
      timeoutMs: processTimeoutMs,
      maxOutputBytes: processMaxOutputBytes,
    });
  } catch (error) {
    if (error instanceof CodexChatError) throw error;
    fail("SCANNER_UNAVAILABLE", `Secret scanner could not start: ${error.message}`);
  }
  if (versionResult.code !== 0) {
    fail("SCANNER_FAILED", "Secret scanner version check failed.");
  }
  const version = versionResult.stdout.trim() || versionResult.stderr.trim();
  if (!testMode) {
    if (path.basename(executable).toLowerCase() !== "gitleaks") {
      fail("SCANNER_IDENTITY_INVALID", "Secret scanner executable is not gitleaks.");
    }
    const help = await run(executable, ["--help"], {
      timeoutMs: processTimeoutMs,
      maxOutputBytes: processMaxOutputBytes,
    }).catch((error) => {
      if (error instanceof CodexChatError) throw error;
      fail("SCANNER_UNAVAILABLE", `Secret scanner identity check failed: ${error.message}`);
    });
    if (
      help.code !== 0 ||
      !/\bgitleaks\b/i.test(`${help.stdout}\n${help.stderr}`) ||
      !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)
    ) {
      fail("SCANNER_IDENTITY_INVALID", "Secret scanner identity could not be verified.");
    }
  }
  return { mode: "gitleaks", executable, version };
}

export async function scanDirectory(directory, scanner, {
  testMode = false,
  processTimeoutMs = MAX_PROCESS_MS,
  processMaxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  const inspected = await inspectScanner(scanner, {
    testMode,
    processTimeoutMs,
    processMaxOutputBytes,
  });
  if (inspected.mode === "skip") {
    return { ...inspected, clean: true };
  }
  const canonicalTarget = await realpath(directory).catch(() => null);
  const targetInfo = canonicalTarget
    ? await lstat(canonicalTarget).catch(() => null)
    : null;
  if (!targetInfo || (!targetInfo.isDirectory() && !targetInfo.isFile())) {
    fail("SCANNER_TARGET_INVALID", `Secret scan target is invalid: ${directory}`);
  }
  let policyDirectory;
  let result;
  try {
    policyDirectory = await mkdtemp(
      path.join(os.tmpdir(), "codex-chat-gitleaks-policy-"),
    );
    result = await run(
      inspected.executable,
      [
        "dir",
        "--no-banner",
        "--no-color",
        "--redact=100",
        "--exit-code",
        "11",
        "--ignore-gitleaks-allow",
        "--gitleaks-ignore-path",
        policyDirectory,
        canonicalTarget,
      ],
      {
        cwd: policyDirectory,
        timeoutMs: processTimeoutMs,
        maxOutputBytes: processMaxOutputBytes,
      },
    );
  } catch (error) {
    if (error instanceof CodexChatError) throw error;
    fail("SCANNER_UNAVAILABLE", `Secret scanner could not start: ${error.message}`);
  } finally {
    if (policyDirectory) {
      await rm(policyDirectory, { recursive: true, force: true });
    }
  }
  if (result.code === 11) {
    fail("SECRET_DETECTED", "Secret scanner rejected the staged collaboration payload.");
  }
  if (result.code !== 0) {
    fail("SCANNER_FAILED", "Secret scanner failed.", {
      exitCode: result.code,
      signal: result.signal,
      stderr: result.stderr.slice(0, 2000),
    });
  }
  return {
    ...inspected,
    configuration: "builtin-default",
    environmentSanitized: true,
    inlineAllowDisabled: true,
    ignoreFileIsolated: true,
    clean: true,
  };
}
