#!/usr/bin/env node

import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { required } from "./lib/args.mjs";
import { createCommandRegistry } from "./lib/command-registry.mjs";
import { CodexChatError } from "./lib/errors.mjs";
import { preflight } from "./lib/preflight.mjs";
import { packContext } from "./lib/pack.mjs";
import {
  prepareCapsule,
  validateCapsule,
} from "./lib/capsule-preparation.mjs";
import { createTransportManifest } from "./lib/transport-plan.mjs";
import { createContextManifest } from "./lib/context-manifest.mjs";
import { createDeliveryReceipt } from "./lib/delivery-receipt.mjs";
import {
  openCoordinationControlPlane,
} from "./lib/distributed-coordination.mjs";
import {
  executeRemoteCoordination,
  startCoordinationHttpServer,
} from "./lib/distributed-coordination-http.mjs";
import { LIMITS_DISTRIBUTED_V1 } from "./lib/limits.mjs";
import { importResult, parseResultEnvelope } from "./lib/import.mjs";
import { buildRecoveryPlan } from "./lib/recovery-plan.mjs";
import { loadRun, recordEvent } from "./lib/state.mjs";
import {
  createTerminalCaptureReceipt,
  revalidateActiveTerminalCapture,
} from "./lib/terminal-capture.mjs";
import { transportGate } from "./lib/transport-gate.mjs";
import { advanceTransportAttempt } from "./lib/transport-attempt.mjs";
import { egoBootstrapLease } from "./lib/ego-bootstrap-lease.mjs";
import { runVerification } from "./lib/verify.mjs";

const CLI_VERSION = "0.1.0";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const COMMAND_CONTRACTS = [
  {
    name: "preflight",
    required: ["root"],
    optional: ["state-dir", "include"],
    repeatable: ["include"],
    execute: executePreflight,
  },
  {
    name: "transport-attempt",
    required: [
      "action", "workspace-id", "coordinator-id", "work-unit-id", "agent-id",
      "attempt-id",
    ],
    optional: [
      "transport-state-dir", "observation", "observation-json",
      "primary-available", "ego-available",
    ],
    repeatable: [],
    execute: executeTransportAttempt,
  },
  {
    name: "transport-gate",
    required: ["action"],
    optional: ["transport-state-dir", "claim-token"],
    repeatable: [],
    execute: executeTransportGate,
  },
  {
    name: "ego-bootstrap-lease",
    required: [
      "action", "workspace-id", "coordinator-id", "work-unit-id", "agent-id",
      "attempt-id",
    ],
    optional: [
      "transport-state-dir", "lease-id", "lease-token", "ttl-ms",
    ],
    repeatable: [],
    execute: executeEgoBootstrapLease,
  },
  {
    name: "pack",
    required: ["root", "output"],
    optional: [
      "state-dir", "include", "max-file-bytes", "max-total-bytes",
    ],
    repeatable: ["include"],
    execute: executePack,
  },
  {
    name: "prepare-capsule",
    required: [
      "root", "task-envelope", "capsule-id", "transport-kind",
      "upload-capability", "output-root",
    ],
    optional: ["include"],
    repeatable: ["include"],
    execute: executePrepareCapsule,
  },
  {
    name: "capsule-validate",
    required: [
      "output-root", "capsule-id", "receipt-sha256", "transport-kind",
      "upload-capability",
    ],
    optional: [],
    repeatable: [],
    execute: executeCapsuleValidate,
  },
  {
    name: "transport-plan",
    required: [
      "root", "context", "context-sha256", "task-envelope",
      "task-envelope-sha256", "transport-kind", "upload-capability", "output",
    ],
    optional: [],
    repeatable: [],
    execute: executeTransportPlan,
  },
  {
    name: "manifest",
    required: ["root", "plan", "output"],
    optional: [],
    repeatable: [],
    execute: executeManifest,
  },
  {
    name: "delivery-receipt",
    required: ["run-id", "manifest", "plan", "evidence"],
    optional: ["state-dir"],
    repeatable: [],
    execute: executeDeliveryReceipt,
  },
  {
    name: "terminal-capture",
    required: ["run-id", "capture", "result"],
    optional: ["state-dir", "result-mode"],
    repeatable: [],
    execute: executeTerminalCapture,
  },
  {
    name: "control-serve",
    required: [],
    optional: [
      "state-dir", "tls-key", "tls-cert", "tls-ca", "require-client-cert",
      "port", "host",
    ],
    repeatable: [],
    execute: executeControlServe,
  },
  {
    name: "control",
    required: [],
    optional: [
      "request", "request-json", "endpoint", "ca", "client-key", "client-cert",
    ],
    repeatable: [],
    execute: executeControl,
  },
  {
    name: "record",
    required: ["run-id", "event", "expected-sequence", "expected-state"],
    optional: ["state-dir", "idempotency-key", "data", "data-json"],
    repeatable: [],
    execute: executeRecord,
  },
  {
    name: "status",
    required: ["run-id"],
    optional: ["state-dir"],
    repeatable: [],
    execute: executeRunInspection,
  },
  {
    name: "resume",
    required: ["run-id"],
    optional: ["state-dir"],
    repeatable: [],
    execute: executeRunInspection,
  },
  {
    name: "recovery-plan",
    required: ["run-id"],
    optional: ["state-dir"],
    repeatable: [],
    execute: executeRunInspection,
  },
  {
    name: "import",
    required: ["run-id", "result"],
    optional: ["state-dir", "scratch", "include"],
    repeatable: ["include"],
    execute: executeImport,
  },
  {
    name: "verify",
    required: ["plan", "plan-sha256", "evidence-dir"],
    optional: [],
    repeatable: [],
    execute: executeVerify,
  },
];

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitSuccess(command, data) {
  emit({
    schema: "codex-chat/cli/v1",
    ok: true,
    protocolVersion: 1,
    stateVersion: 1,
    command,
    data,
  });
}

async function readJsonOption(filePath, label, maxBytes = null) {
  try {
    const bytes = await readFile(path.resolve(filePath));
    if (maxBytes !== null && bytes.byteLength > maxBytes) {
      throw new CodexChatError(
        "JSON_FILE_TOO_LARGE",
        `${label} exceeds its protocol byte limit.`,
      );
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof CodexChatError) throw error;
    throw new CodexChatError("JSON_FILE_INVALID", `${label} is not valid JSON: ${error.message}`);
  }
}

function parseInlineJson(value, label, maxBytes = null) {
  if (maxBytes !== null && Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new CodexChatError(
      "JSON_INLINE_TOO_LARGE",
      `${label} exceeds its protocol byte limit.`,
    );
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new CodexChatError("JSON_INLINE_INVALID", `${label} is not valid JSON: ${error.message}`);
  }
}

function requiredControlToken() {
  const token = process.env.CODEX_CHAT_CONTROL_TOKEN;
  if (!token) {
    throw new CodexChatError(
      "CONTROL_TOKEN_REQUIRED",
      "CODEX_CHAT_CONTROL_TOKEN is required.",
    );
  }
  return token;
}

function parseBooleanOption(value, label) {
  if (value === undefined) return false;
  if (!["true", "false"].includes(value)) {
    throw new CodexChatError(
      "USAGE",
      `${label} must be true or false.`,
    );
  }
  return value === "true";
}

function waitForShutdownSignal() {
  return new Promise((resolve) => {
    const finish = (signal) => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      resolve(signal);
    };
    const onInterrupt = () => finish("SIGINT");
    const onTerminate = () => finish("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
  });
}

async function executeControlServe({ command, options, context }) {
  const token = requiredControlToken();
  const hasTlsKey = Object.hasOwn(options, "tls-key");
  const hasTlsCert = Object.hasOwn(options, "tls-cert");
  if (hasTlsKey !== hasTlsCert) {
    throw new CodexChatError(
      "CONTROL_TLS_CONFIG_INVALID",
      "Use --tls-key and --tls-cert together.",
    );
  }
  const port = Number(options.port ?? "9443");
  if (!Number.isInteger(port)) {
    throw new CodexChatError("USAGE", "--port must be an integer.");
  }
  const tls = hasTlsKey
    ? {
        key: await readFile(path.resolve(options["tls-key"])),
        cert: await readFile(path.resolve(options["tls-cert"])),
        ...(options["tls-ca"]
          ? { ca: await readFile(path.resolve(options["tls-ca"])) }
          : {}),
        requestCert: parseBooleanOption(
          options["require-client-cert"],
          "--require-client-cert",
        ),
      }
    : null;
  const controlPlane = await openCoordinationControlPlane({
    stateDir: context.stateDir,
  });
  let server = null;
  try {
    server = await startCoordinationHttpServer({
      controlPlane,
      host: options.host ?? "127.0.0.1",
      port,
      token,
      tls,
    });
    emitSuccess(command, {
      endpoint: server.endpoint,
      stateDir: path.resolve(context.stateDir),
      tls: tls !== null,
      clientCertificateRequired: tls?.requestCert === true,
    });
    await waitForShutdownSignal();
  } finally {
    try {
      await server?.close();
    } finally {
      await controlPlane.close();
    }
  }
}

async function executeControl({ command, options }) {
  if (options.request && options["request-json"]) {
    throw new CodexChatError(
      "USAGE",
      "Use only one of --request or --request-json.",
    );
  }
  const request = options.request
    ? await readJsonOption(
        options.request,
        "control request",
        LIMITS_DISTRIBUTED_V1.control.maxRequestBytes,
      )
    : options["request-json"]
      ? parseInlineJson(options["request-json"], "control request")
      : (() => {
          throw new CodexChatError(
            "USAGE",
            "Missing required option --request or --request-json.",
          );
        })();
  const hasClientKey = Object.hasOwn(options, "client-key");
  const hasClientCert = Object.hasOwn(options, "client-cert");
  if (hasClientKey !== hasClientCert) {
    throw new CodexChatError(
      "CONTROL_TLS_CONFIG_INVALID",
      "Use --client-key and --client-cert together.",
    );
  }
  emitSuccess(
    command,
    await executeRemoteCoordination({
      endpoint:
        options.endpoint ??
        process.env.CODEX_CHAT_CONTROL_ENDPOINT ??
        required(options, "endpoint"),
      token: requiredControlToken(),
      request,
      ...(options.ca
        ? { ca: await readFile(path.resolve(options.ca)) }
        : {}),
      ...(hasClientKey
        ? {
            key: await readFile(path.resolve(options["client-key"])),
            cert: await readFile(path.resolve(options["client-cert"])),
          }
        : {}),
    }),
  );
}

async function executePreflight({ command, options, context }) {
  const root = required(options, "root");
  emitSuccess(
    command,
    await preflight({
      root,
      stateDir: context.stateDir,
      includes: options.include,
      scanner: "gitleaks",
    }),
  );
}

async function executeTransportAttempt({ command, options, context }) {
  const action = required(options, "action");
  if (options.observation && options["observation-json"]) {
    throw new CodexChatError(
      "USAGE",
      "Use only one of --observation or --observation-json.",
    );
  }
  const observation = options.observation
    ? await readJsonOption(
        options.observation,
        "transport observation",
        64 * 1024,
      )
    : options["observation-json"]
      ? parseInlineJson(
          options["observation-json"],
          "transport observation",
          64 * 1024,
        )
      : null;
  emitSuccess(
    command,
    await advanceTransportAttempt({
      action,
      transportStateDir: context.transportStateDir,
      owner: {
        workspaceId: required(options, "workspace-id"),
        coordinatorId: required(options, "coordinator-id"),
        workUnitId: required(options, "work-unit-id"),
        agentId: required(options, "agent-id"),
        attemptId: required(options, "attempt-id"),
      },
      ...(action === "start"
        ? {
            availability: {
              primary: parseBooleanOption(
                required(options, "primary-available"),
                "--primary-available",
              ),
              ego: parseBooleanOption(
                required(options, "ego-available"),
                "--ego-available",
              ),
            },
          }
        : {}),
      ...(observation === null ? {} : { observation }),
    }),
  );
}

async function executeTransportGate({ command, options, context }) {
  emitSuccess(
    command,
    await transportGate({
      action: required(options, "action"),
      claimToken: options["claim-token"] ?? null,
      transportStateDir: context.transportStateDir,
    }),
  );
}

async function executeEgoBootstrapLease({ command, options, context }) {
  emitSuccess(
    command,
    await egoBootstrapLease({
      action: required(options, "action"),
      transportStateDir: context.transportStateDir,
      owner: {
        workspaceId: required(options, "workspace-id"),
        coordinatorId: required(options, "coordinator-id"),
        workUnitId: required(options, "work-unit-id"),
        agentId: required(options, "agent-id"),
        attemptId: required(options, "attempt-id"),
      },
      leaseId: options["lease-id"] ?? null,
      leaseToken: options["lease-token"] ?? null,
      ...(options["ttl-ms"] === undefined
        ? {}
        : { ttlMs: Number(options["ttl-ms"]) }),
    }),
  );
}

async function executePack({ command, options, context }) {
  if (
    Object.hasOwn(options, "max-file-bytes") ||
    Object.hasOwn(options, "max-total-bytes")
  ) {
    throw new CodexChatError(
      "LIMIT_OVERRIDE_FORBIDDEN",
      "Installed CLI packing limits are fixed by protocol v1.",
    );
  }
  const root = required(options, "root");
  const result = await packContext({
    root,
    includes: options.include,
    output: required(options, "output"),
    scanner: "gitleaks",
  });
  emitSuccess(command, {
    root: path.resolve(root),
    stateDir: path.resolve(context.stateDir),
    ...result,
  });
}

async function executePrepareCapsule({ command, options }) {
  emitSuccess(
    command,
    await prepareCapsule({
      root: required(options, "root"),
      includes: options.include,
      taskEnvelopePath: required(options, "task-envelope"),
      capsuleId: required(options, "capsule-id"),
      transportKind: required(options, "transport-kind"),
      uploadCapability: required(options, "upload-capability"),
      outputRoot: required(options, "output-root"),
      scanner: "gitleaks",
    }),
  );
}

async function executeCapsuleValidate({ command, options }) {
  emitSuccess(
    command,
    await validateCapsule({
      outputRoot: required(options, "output-root"),
      capsuleId: required(options, "capsule-id"),
      expectedReceiptSha256: required(options, "receipt-sha256"),
      expectedTransportKind: required(options, "transport-kind"),
      expectedUploadCapability: required(options, "upload-capability"),
    }),
  );
}

async function executeTransportPlan({ command, options }) {
  emitSuccess(
    command,
    await createTransportManifest({
      root: required(options, "root"),
      contextPath: required(options, "context"),
      expectedContextSha256: required(options, "context-sha256"),
      taskEnvelopePath: required(options, "task-envelope"),
      expectedTaskEnvelopeSha256: required(
        options,
        "task-envelope-sha256",
      ),
      transportKind: required(options, "transport-kind"),
      uploadCapability: required(options, "upload-capability"),
      output: required(options, "output"),
      scanner: "gitleaks",
    }),
  );
}

async function executeManifest({ command, options }) {
  emitSuccess(
    command,
    await createContextManifest({
      root: required(options, "root"),
      planPath: required(options, "plan"),
      output: required(options, "output"),
      scanner: "gitleaks",
    }),
  );
}

async function executeDeliveryReceipt({ command, options, context }) {
  emitSuccess(
    command,
    await createDeliveryReceipt({
      stateDir: context.stateDir,
      runId: required(options, "run-id"),
      manifestPath: required(options, "manifest"),
      planPath: required(options, "plan"),
      evidencePath: required(options, "evidence"),
      scanner: "gitleaks",
    }),
  );
}

async function executeTerminalCapture({ command, options, context }) {
  emitSuccess(
    command,
    await createTerminalCaptureReceipt({
      stateDir: context.stateDir,
      runId: required(options, "run-id"),
      capturePath: required(options, "capture"),
      resultPath: required(options, "result"),
      resultMode: options["result-mode"] ?? "accepted",
      scanner: "gitleaks",
    }),
  );
}

async function executeRecord({ command, options, context }) {
  const event = required(options, "event");
  const expectedStateValue = required(options, "expected-state");
  if (options.data && options["data-json"]) {
    throw new CodexChatError("USAGE", "Use only one of --data or --data-json.");
  }
  const result = await recordEvent({
    stateDir: context.stateDir,
    runId: required(options, "run-id"),
    event,
    expectedSequence: Number(required(options, "expected-sequence")),
    expectedState: expectedStateValue === "null" ? null : expectedStateValue,
    idempotencyKey: options["idempotency-key"] ?? null,
    data: options.data
      ? await readJsonOption(options.data, "record data")
      : options["data-json"]
        ? parseInlineJson(options["data-json"], "record data")
        : {},
  });
  emitSuccess(command, result);
}

async function executeRunInspection({ command, options, context }) {
  const state = await loadRun({
    stateDir: context.stateDir,
    runId: required(options, "run-id"),
  });
  const recoveryPlan = buildRecoveryPlan(state);
  if (command === "recovery-plan") {
    emitSuccess(command, recoveryPlan);
    return;
  }
  emitSuccess(command, {
    state,
    sendAllowed: false,
    sendEligibleAfterConclusiveMarkerAbsence:
      state.phase === "send_reserved",
    resendAllowed: false,
    nextAction: state.nextAction,
    recoveryPlan,
  });
}

async function executeImport({ command, options, context }) {
  const runId = required(options, "run-id");
  const state = await loadRun({ stateDir: context.stateDir, runId });
  if (state.phase !== "reviewing") {
    throw new CodexChatError(
      "IMPORT_STATE_INVALID",
      `Import is only allowed while reviewing a terminal response; current state is ${state.phase}.`,
    );
  }
  if (state.outbound?.outboundBindingVersion === 2) {
    await revalidateActiveTerminalCapture({
      stateDir: context.stateDir,
      runId,
      current: state,
    });
  }
  const resultPath = required(options, "result");
  const resultBytes = await readFile(path.resolve(resultPath));
  const expectedResultDigest =
    state.collaboration?.responseBinding?.resultEnvelopeSha256;
  if (
    !/^[a-f0-9]{64}$/.test(expectedResultDigest ?? "") ||
    sha256(resultBytes) !== expectedResultDigest
  ) {
    throw new CodexChatError(
      "RESULT_RESPONSE_DIGEST_MISMATCH",
      "Result bytes do not match the terminal response envelope binding.",
    );
  }
  let resultRaw;
  try {
    resultRaw = new TextDecoder("utf-8", { fatal: true }).decode(resultBytes);
  } catch {
    throw new CodexChatError(
      "RESULT_UTF8_INVALID",
      "Result envelope must be valid UTF-8.",
    );
  }
  const envelope = parseResultEnvelope(resultRaw);
  if (envelope.runId !== runId) {
    throw new CodexChatError(
      "RESULT_RUN_MISMATCH",
      "Result runId does not match the durable run.",
    );
  }
  if (envelope.contextSha256 !== state.outbound?.payloadSha256) {
    throw new CodexChatError(
      "RESULT_CONTEXT_MISMATCH",
      "Result context digest does not match the active outbound collaboration bundle.",
    );
  }
  const result = await importResult({
    envelope,
    scratch:
      envelope.artifactKind === "patch"
        ? required(options, "scratch")
        : null,
    sourceRoot: state.sourceRoot,
    quarantineDir: path.join(
      path.resolve(context.stateDir),
      runId,
      "quarantine",
    ),
    targetLockDir: path.join(path.resolve(context.stateDir), ".target-locks"),
    allowedPaths:
      envelope.artifactKind === "patch"
        ? options.include
        : [],
    expectedRunId: runId,
    expectedTurnId: state.outbound?.turnId,
    expectedContextSha256: state.outbound.payloadSha256,
    scanner: "gitleaks",
  });
  emitSuccess(command, result);
}

async function executeVerify({ command, options }) {
  emitSuccess(
    command,
    await runVerification({
      planPath: required(options, "plan"),
      expectedPlanSha256: required(options, "plan-sha256"),
      evidenceDir: required(options, "evidence-dir"),
    }),
  );
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const commandRegistry = createCommandRegistry(COMMAND_CONTRACTS);
  if (
    rawArgs.length === 1 &&
    (rawArgs[0] === "--help" || rawArgs[0] === "help")
  ) {
    emitSuccess("help", {
      version: CLI_VERSION,
      usage:
        "Invoke the Codex skill with $codex-chat, or run codex-chat <command> [options].",
      ...commandRegistry.describe(),
      documentation: "See SKILL.md and references/protocol.md for complete workflows.",
    });
    return;
  }
  if (
    rawArgs.length === 1 &&
    (rawArgs[0] === "--version" || rawArgs[0] === "version")
  ) {
    emitSuccess("version", { version: CLI_VERSION });
    return;
  }

  const invocation = commandRegistry.parse(rawArgs);
  const { options } = invocation;
  const stateDir =
    options["state-dir"] ??
    process.env.CODEX_CHAT_STATE_DIR ??
    path.join(os.homedir(), ".codex", "codex-chat", "runs");
  const transportStateDir =
    options["transport-state-dir"] ??
    process.env.CODEX_CHAT_TRANSPORT_STATE_DIR ??
    path.join(os.homedir(), ".codex", "codex-chat", "transport");
  await commandRegistry.execute(invocation, { stateDir, transportStateDir });
}

main().catch((error) => {
  const known = error instanceof CodexChatError;
  emit({
    schema: "codex-chat/cli/v1",
    ok: false,
    protocolVersion: 1,
    error: {
      code: known ? error.code : "INTERNAL",
      message: error.message,
      ...(known && error.details !== undefined ? { details: error.details } : {}),
    },
  });
  process.exitCode = known ? 2 : 1;
});
