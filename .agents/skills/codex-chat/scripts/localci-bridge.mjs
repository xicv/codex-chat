#!/usr/bin/env node

import { CodexChatError } from "./lib/errors.mjs";
import {
  validateBridgeJobFile,
  validateBridgeResultFile,
} from "./lib/localci-bridge.mjs";

const USAGE = [
  "Usage:",
  "  codex-chat-localci-bridge job-validate --file <job.json> --repository <owner/repo> --base-sha <sha> [--default-branch main]",
  "  codex-chat-localci-bridge result-validate --job <job.json> --result <result.json> --repository <owner/repo> --base-sha <sha>",
  "    --request-pr-number <n> --request-head-sha <sha> --request-file-sha256 <sha> --bridge-main-sha <sha> --config-blob-sha <sha>",
  "    --request-blob-sha <sha> [--default-branch main] [--head-sha <sha>] [--pr-number <number>]",
].join("\n");

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  if (!command || ["--help", "help", "-h"].includes(command)) {
    return { command: "help", options };
  }
  if (rest.length % 2 !== 0) {
    throw new CodexChatError("USAGE", USAGE);
  }
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key.startsWith("--") || value.startsWith("--")) {
      throw new CodexChatError("USAGE", USAGE);
    }
    const name = key.slice(2);
    if (Object.hasOwn(options, name)) {
      throw new CodexChatError("USAGE", `Duplicate option --${name}.`);
    }
    options[name] = value;
  }
  return { command, options };
}

function contract(options, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) {
      throw new CodexChatError("USAGE", `Unknown option --${name}.`);
    }
  }
  for (const name of required) {
    if (!Object.hasOwn(options, name)) {
      throw new CodexChatError("USAGE", `Missing option --${name}.`);
    }
  }
}

function parsePrNumber(value) {
  if (value === undefined) return null;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new CodexChatError("USAGE", "--pr-number must be a positive integer.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CodexChatError("USAGE", "--pr-number is too large.");
  }
  return parsed;
}

function emit(command, data) {
  process.stdout.write(`${JSON.stringify({
    schema: "codex-chat/cli/v1",
    ok: true,
    protocolVersion: 1,
    stateVersion: 1,
    command,
    data,
  })}\n`);
}

async function main() {
  const invocation = parse(process.argv.slice(2));
  if (invocation.command === "help") {
    emit("help", { usage: USAGE, actionAuthorized: false });
    return;
  }
  if (invocation.command === "job-validate") {
    contract(
      invocation.options,
      ["file", "repository", "base-sha"],
      ["default-branch"],
    );
    emit(
      invocation.command,
      await validateBridgeJobFile(invocation.options.file, {
        repository: invocation.options.repository,
        baseSha: invocation.options["base-sha"],
        defaultBranch: invocation.options["default-branch"] ?? "main",
      }),
    );
    return;
  }
  if (invocation.command === "result-validate") {
    // Six independently supplied binding values are REQUIRED: they must
    // come from the reviewer's own GitHub/git queries (or the default-branch
    // validator receipt), never from the result being validated.
    contract(
      invocation.options,
      ["job", "result", "repository", "base-sha",
       "request-pr-number", "request-head-sha", "request-file-sha256",
       "bridge-main-sha", "config-blob-sha", "request-blob-sha"],
      ["default-branch", "head-sha", "pr-number"],
    );
    const job = await validateBridgeJobFile(invocation.options.job, {
      repository: invocation.options.repository,
      baseSha: invocation.options["base-sha"],
      defaultBranch: invocation.options["default-branch"] ?? "main",
    });
    const checked = await validateBridgeResultFile(
      invocation.options.result,
      job,
      {
        headSha: invocation.options["head-sha"] ?? null,
        pullRequestNumber: parsePrNumber(invocation.options["pr-number"]),
      },
    );
    // Exact comparison against independently supplied values. The request PR
    // number uses the same strict positive-safe-integer parsing as
    // --pr-number: "12junk", 0, negative, and unsafe-integer values are
    // rejected outright instead of silently coercing.
    const expectedRequest = {
      pr_number: parsePrNumber(invocation.options["request-pr-number"]),
      head_sha: invocation.options["request-head-sha"],
      request_file_sha256: invocation.options["request-file-sha256"],
    };
    const expectedBridge = {
      main_sha: invocation.options["bridge-main-sha"],
      config_blob_sha: invocation.options["config-blob-sha"],
      request_blob_sha: invocation.options["request-blob-sha"],
    };
    const actualRequest = checked.result.request_binding;
    for (const key of Object.keys(expectedRequest)) {
      if (actualRequest[key] !== expectedRequest[key]) {
        throw new CodexChatError("BINDING_MISMATCH", `result.request_binding.${key} is ${actualRequest[key]}, independently supplied value is ${expectedRequest[key]}.`);
      }
    }
    const actualBridge = checked.result.bridge_binding;
    for (const key of Object.keys(expectedBridge)) {
      if (actualBridge[key] !== expectedBridge[key]) {
        throw new CodexChatError("BINDING_MISMATCH", `result.bridge_binding.${key} is ${actualBridge[key]}, independently supplied value is ${expectedBridge[key]}.`);
      }
    }
    emit(
      invocation.command,
      Object.assign({}, checked, {
        independently_bound: {
          request_binding: expectedRequest,
          bridge_binding: expectedBridge,
        },
      }),
    );
    return;
  }
  throw new CodexChatError("UNKNOWN_COMMAND", `Unknown command: ${invocation.command}`);
}

main().catch((error) => {
  const known = error instanceof CodexChatError;
  process.stdout.write(`${JSON.stringify({
    schema: "codex-chat/cli/v1",
    ok: false,
    protocolVersion: 1,
    error: {
      code: known ? error.code : "INTERNAL",
      message: error.message,
      ...(known && error.details !== undefined ? { details: error.details } : {}),
    },
  })}\n`);
  process.exitCode = known ? 2 : 1;
});
