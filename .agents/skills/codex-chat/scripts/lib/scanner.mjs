import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fail } from "./errors.mjs";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
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

export async function inspectScanner(scanner, { testMode = false } = {}) {
  if (scanner === "skip") {
    if (!testMode) {
      fail("SCANNER_BYPASS_FORBIDDEN", "Secret scanning cannot be skipped outside test mode.");
    }
    return { mode: "skip", executable: null, version: null };
  }

  const executable = await resolveExecutable(scanner);
  let versionResult;
  try {
    versionResult = await run(executable, ["version"]);
  } catch (error) {
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
    const help = await run(executable, ["--help"]).catch((error) => {
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

export async function scanDirectory(directory, scanner, { testMode = false } = {}) {
  const inspected = await inspectScanner(scanner, { testMode });
  if (inspected.mode === "skip") {
    return { ...inspected, clean: true };
  }

  let result;
  try {
    result = await run(inspected.executable, [
      "dir",
      "--no-banner",
      "--no-color",
      "--redact=100",
      "--exit-code",
      "11",
      directory,
    ]);
  } catch (error) {
    fail("SCANNER_UNAVAILABLE", `Secret scanner could not start: ${error.message}`);
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
    clean: true,
  };
}
