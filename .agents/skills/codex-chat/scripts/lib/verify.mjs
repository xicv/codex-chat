import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fail } from "./errors.mjs";
import { LIMITS_V1 } from "./limits.mjs";

const {
  maxPlanBytes: MAX_PLAN_BYTES,
  maxArgvItems: MAX_ARGV_ITEMS,
  maxArgBytes: MAX_ARG_BYTES,
  maxTimeoutMs: MAX_TIMEOUT_MS,
  maxOutputBytes: MAX_OUTPUT_BYTES,
} = LIMITS_V1.verify;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const EVIDENCE_CLASSES = new Set([
  "local-synthetic",
  "local-synthetic-e2e",
  "local-unit",
  "local-contract",
  "local-chaos",
  "local-e2e",
  "local-lint",
  "local-typecheck",
  "local-build",
  "local-repository",
]);
const SHELL_EXECUTABLES = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh",
  "pwsh", "powershell", "cmd", "cmd.exe",
]);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stable(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parsePlan(contents) {
  if (Buffer.byteLength(contents) > MAX_PLAN_BYTES) {
    fail("VERIFY_PLAN_TOO_LARGE", `Verification plan exceeds ${MAX_PLAN_BYTES} bytes.`);
  }
  let plan;
  try {
    plan = JSON.parse(contents);
  } catch {
    fail("VERIFY_PLAN_INVALID", "Verification plan is not valid JSON.");
  }
  if (
    plan?.kind !== "CODEX_CHAT_VERIFY_V1" ||
    plan.protocolVersion !== 1 ||
    !path.isAbsolute(plan.cwd ?? "") ||
    !path.isAbsolute(plan.sourceRoot ?? "") ||
    !path.isAbsolute(plan.scratchRoot ?? "") ||
    !Array.isArray(plan.argv) ||
    plan.argv.length === 0 ||
    plan.argv.length > MAX_ARGV_ITEMS ||
    plan.argv.some((value) =>
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value) > MAX_ARG_BYTES ||
      value.includes("\0")
    ) ||
    !Number.isInteger(plan.timeoutMs) ||
    plan.timeoutMs < 1 ||
    plan.timeoutMs > MAX_TIMEOUT_MS ||
    !EVIDENCE_CLASSES.has(plan.evidenceClass)
  ) {
    fail("VERIFY_PLAN_INVALID", "Verification plan does not match CODEX_CHAT_VERIFY_V1.");
  }
  if (plan.env !== undefined) {
    if (!plan.env || typeof plan.env !== "object" || Array.isArray(plan.env)) {
      fail("VERIFY_PLAN_INVALID", "Verification env must be an object.");
    }
    for (const [key, value] of Object.entries(plan.env)) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        typeof value !== "string" ||
        /(secret|token|password|cookie|private|credential|api.?key)/i.test(key) ||
        ["HOME", "TMPDIR", "CI"].includes(key)
      ) {
        fail("VERIFY_ENV_REJECTED", `Unsafe verification environment key: ${key}`);
      }
    }
  }
  return plan;
}

function limitedEnvironment(extra = {}, isolatedHome, isolatedTmp) {
  const defaultPath = [
    path.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter((value, index, values) => values.indexOf(value) === index).join(path.delimiter);
  const environment = {
    ...extra,
    PATH: extra.PATH ?? defaultPath,
    CI: "1",
    HOME: isolatedHome,
    TMPDIR: isolatedTmp,
  };
  for (const key of ["LANG", "LC_ALL"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

async function resolveExecutable(command, environment) {
  if (path.isAbsolute(command)) {
    await access(command, fsConstants.X_OK).catch(() => {
      fail("VERIFY_EXECUTABLE_INVALID", `Executable is not accessible: ${command}`);
    });
    return realpath(path.resolve(command));
  }
  for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    if (await access(candidate, fsConstants.X_OK).then(() => true, () => false)) {
      return realpath(candidate);
    }
  }
  fail("VERIFY_EXECUTABLE_INVALID", `Executable was not found on the restricted PATH: ${command}`);
}

function isWithin(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function inspectDirectory(directory, code) {
  const absolute = path.resolve(directory);
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    fail(code, `Directory must be a real directory: ${absolute}`);
  }
  return realpath(absolute);
}

function enforceExecutablePolicy(executable, args) {
  const base = path.basename(executable).toLowerCase();
  if (SHELL_EXECUTABLES.has(base)) {
    fail("VERIFY_EXECUTABLE_POLICY", `Shell executables are forbidden: ${base}`);
  }
  if (base === "env" || base === "env.exe") {
    fail(
      "VERIFY_EXECUTABLE_POLICY",
      "Environment dispatchers are forbidden; resolve and invoke the target executable directly.",
    );
  }
  const evaluationFlags =
    base.startsWith("node")
      ? new Set(["-e", "--eval", "-p", "--print"])
      : base.startsWith("python")
        ? new Set(["-c"])
        : ["ruby", "perl"].some((name) => base.startsWith(name))
          ? new Set(["-e"])
          : new Set();
  if (args.some((argument) => evaluationFlags.has(argument))) {
    fail("VERIFY_EXECUTABLE_POLICY", `Inline interpreter evaluation is forbidden: ${base}`);
  }
}

async function writeImmutable(filePath, contents) {
  const handle = await open(filePath, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") {
      fail("VERIFY_EVIDENCE_CONFLICT", `Evidence path already exists: ${filePath}`);
    }
    throw error;
  });
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function runVerification({
  planPath,
  evidenceDir,
  expectedPlanSha256,
}) {
  const contents = await readFile(path.resolve(planPath), "utf8");
  const plan = parsePlan(contents);
  const [sourceRoot, scratchRoot, canonicalCwd] = await Promise.all([
    inspectDirectory(plan.sourceRoot, "VERIFY_SOURCE_INVALID"),
    inspectDirectory(plan.scratchRoot, "VERIFY_SCRATCH_INVALID"),
    inspectDirectory(plan.cwd, "VERIFY_CWD_INVALID"),
  ]);
  if (
    isWithin(sourceRoot, scratchRoot) ||
    isWithin(scratchRoot, sourceRoot)
  ) {
    fail("VERIFY_SCRATCH_CONFINEMENT", "Source and scratch roots must be separate and non-nested.");
  }
  if (!isWithin(scratchRoot, canonicalCwd)) {
    fail("VERIFY_CWD_OUTSIDE_SCRATCH", "Verification cwd is outside the authorised scratch root.");
  }
  const requestedEvidence = path.resolve(evidenceDir);
  if (
    isWithin(sourceRoot, requestedEvidence) ||
    isWithin(requestedEvidence, sourceRoot) ||
    isWithin(scratchRoot, requestedEvidence) ||
    isWithin(requestedEvidence, scratchRoot)
  ) {
    fail(
      "VERIFY_EVIDENCE_CONFINEMENT",
      "Evidence must be in a separate, non-nested directory from source and scratch.",
    );
  }
  const planSha256 = sha256(contents);
  if (
    !/^[a-f0-9]{64}$/.test(expectedPlanSha256 ?? "") ||
    expectedPlanSha256 !== planSha256
  ) {
    fail("VERIFY_PLAN_DIGEST_MISMATCH", "Verification plan changed after it was approved.");
  }
  await mkdir(requestedEvidence, { recursive: true, mode: 0o700 });
  const absoluteEvidence = await inspectDirectory(
    requestedEvidence,
    "VERIFY_EVIDENCE_INVALID",
  );
  if (
    isWithin(sourceRoot, absoluteEvidence) ||
    isWithin(absoluteEvidence, sourceRoot) ||
    isWithin(scratchRoot, absoluteEvidence) ||
    isWithin(absoluteEvidence, scratchRoot)
  ) {
    fail(
      "VERIFY_EVIDENCE_CONFINEMENT",
      "Resolved evidence must be separate and non-nested from source and scratch.",
    );
  }
  const runtimeRoot = path.join(absoluteEvidence, `.runtime-${randomUUID()}`);
  const isolatedHome = path.join(runtimeRoot, "home");
  const isolatedTmp = path.join(runtimeRoot, "tmp");
  await Promise.all([
    mkdir(isolatedHome, { recursive: true, mode: 0o700 }),
    mkdir(isolatedTmp, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(absoluteEvidence, 0o700),
    chmod(runtimeRoot, 0o700),
    chmod(isolatedHome, 0o700),
    chmod(isolatedTmp, 0o700),
  ]);
  const environment = limitedEnvironment(plan.env, isolatedHome, isolatedTmp);
  const resolvedExecutable = await resolveExecutable(plan.argv[0], environment);
  enforceExecutablePolicy(resolvedExecutable, plan.argv.slice(1));
  const environmentFingerprint = sha256(
    JSON.stringify(Object.fromEntries(Object.entries(environment).sort(([a], [b]) =>
      a.localeCompare(b)
    ))),
  );
  const started = process.hrtime.bigint();
  const startedAt = new Date().toISOString();

  const execution = await new Promise((resolve, reject) => {
    const child = spawn(resolvedExecutable, plan.argv.slice(1), {
      cwd: canonicalCwd,
      env: environment,
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
      killTimer ??= setTimeout(() => signal("SIGKILL"), 500);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, plan.timeoutMs);

    function collect(target, chunk) {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputLimited = true;
        terminate();
        return;
      }
      target.push(chunk);
    }
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode,
        signal,
        timedOut,
        outputLimited,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  }).catch((error) => {
    fail("VERIFY_EXEC_FAILED", `Verification command could not start: ${error.message}`);
  });

  if (execution.outputLimited) {
    fail("VERIFY_OUTPUT_LIMIT", `Verification output exceeds ${MAX_OUTPUT_BYTES} bytes.`);
  }
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const finishedAt = new Date().toISOString();
  const stdoutSha256 = sha256(execution.stdout);
  const stderrSha256 = sha256(execution.stderr);
  const receipt = {
    kind: "CODEX_CHAT_VERIFY_RECEIPT_V1",
    protocolVersion: 1,
    executionId: randomUUID(),
    planSha256,
    resolvedExecutable,
    environmentFingerprint,
    sourceRoot,
    scratchRoot,
    cwd: canonicalCwd,
    argv: plan.argv,
    evidenceClass: plan.evidenceClass,
    startedAt,
    finishedAt,
    durationMs,
    exitCode: execution.exitCode,
    signal: execution.signal,
    timedOut: execution.timedOut,
    stdoutBytes: execution.stdout.byteLength,
    stderrBytes: execution.stderr.byteLength,
    stdoutSha256,
    stderrSha256,
  };
  const executionDigest = sha256(stable(receipt));
  const prefix = path.join(absoluteEvidence, executionDigest);
  const stdoutPath = `${prefix}.stdout`;
  const stderrPath = `${prefix}.stderr`;
  const receiptPath = `${prefix}.receipt.json`;
  await writeImmutable(stdoutPath, execution.stdout);
  await writeImmutable(stderrPath, execution.stderr);
  await writeImmutable(receiptPath, `${stable({ ...receipt, executionDigest })}\n`);

  return {
    executionDigest,
    receiptPath,
    planSha256,
    resolvedExecutable,
    environmentFingerprint,
    sourceRoot,
    scratchRoot,
    cwd: canonicalCwd,
    argv: plan.argv,
    evidenceClass: plan.evidenceClass,
    exitCode: execution.exitCode,
    signal: execution.signal,
    timedOut: execution.timedOut,
    durationMs,
    stdoutPath,
    stderrPath,
    stdoutBytes: execution.stdout.byteLength,
    stderrBytes: execution.stderr.byteLength,
    stdoutSha256,
    stderrSha256,
  };
}
