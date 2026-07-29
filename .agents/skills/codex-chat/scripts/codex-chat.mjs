#!/usr/bin/env node

import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { parseArgs, required } from "./lib/args.mjs";
import { CodexChatError } from "./lib/errors.mjs";
import { preflight } from "./lib/preflight.mjs";
import { packContext } from "./lib/pack.mjs";
import { importResult, parseResultEnvelope } from "./lib/import.mjs";
import { loadRun, recordEvent } from "./lib/state.mjs";
import { runVerification } from "./lib/verify.mjs";

const CLI_VERSION = "0.1.0";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const COMMANDS = [
  "preflight",
  "pack",
  "record",
  "status",
  "resume",
  "import",
  "verify",
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

async function readJsonOption(filePath, label) {
  try {
    return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new CodexChatError("JSON_FILE_INVALID", `${label} is not valid JSON: ${error.message}`);
  }
}

function parseInlineJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new CodexChatError("JSON_INLINE_INVALID", `${label} is not valid JSON: ${error.message}`);
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (
    rawArgs.length === 1 &&
    (rawArgs[0] === "--help" || rawArgs[0] === "help")
  ) {
    emitSuccess("help", {
      version: CLI_VERSION,
      usage:
        "Invoke the Codex skill with $codex-chat, or run codex-chat <command> [options].",
      commands: COMMANDS,
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

  const { command, options } = parseArgs(rawArgs);
  if (Object.hasOwn(options, "scanner")) {
    throw new CodexChatError(
      "SCANNER_OVERRIDE_FORBIDDEN",
      "The installed CLI always uses an identity-verified gitleaks executable.",
    );
  }
  const stateDir =
    options["state-dir"] ??
    process.env.CODEX_CHAT_STATE_DIR ??
    path.join(os.homedir(), ".codex", "codex-chat", "runs");
  if (command === "preflight") {
    const root = required(options, "root");
    emitSuccess(
      command,
      await preflight({
        root,
        stateDir,
        includes: options.include,
        scanner: "gitleaks",
      }),
    );
    return;
  }
  if (command === "pack") {
    const root = required(options, "root");
    const result = await packContext({
      root,
      includes: options.include,
      output: required(options, "output"),
      scanner: "gitleaks",
      ...(options["max-file-bytes"]
        ? { maxFileBytes: Number(options["max-file-bytes"]) }
        : {}),
      ...(options["max-total-bytes"]
        ? { maxTotalBytes: Number(options["max-total-bytes"]) }
        : {}),
    });
    emitSuccess(command, {
      root: path.resolve(root),
      stateDir: path.resolve(stateDir),
      ...result,
    });
    return;
  }
  if (command === "record") {
    const event = required(options, "event");
    const expectedStateValue = required(options, "expected-state");
    if (options.data && options["data-json"]) {
      throw new CodexChatError("USAGE", "Use only one of --data or --data-json.");
    }
    const result = await recordEvent({
      stateDir,
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
    return;
  }
  if (command === "status" || command === "resume") {
    const state = await loadRun({
      stateDir,
      runId: required(options, "run-id"),
    });
    emitSuccess(command, {
      state,
      sendAllowed: false,
      sendEligibleAfterConclusiveMarkerAbsence:
        state.phase === "send_reserved",
      resendAllowed: false,
      nextAction: state.nextAction,
    });
    return;
  }
  if (command === "import") {
    const runId = required(options, "run-id");
    const state = await loadRun({ stateDir, runId });
    if (state.phase !== "reviewing") {
      throw new CodexChatError(
        "IMPORT_STATE_INVALID",
        `Import is only allowed while reviewing a terminal response; current state is ${state.phase}.`,
      );
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
      throw new CodexChatError("RESULT_RUN_MISMATCH", "Result runId does not match the durable run.");
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
      quarantineDir: path.join(path.resolve(stateDir), runId, "quarantine"),
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
    return;
  }
  if (command === "verify") {
    emitSuccess(
      command,
      await runVerification({
        planPath: required(options, "plan"),
        expectedPlanSha256: required(options, "plan-sha256"),
        evidenceDir: required(options, "evidence-dir"),
      }),
    );
    return;
  }
  throw new CodexChatError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
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
