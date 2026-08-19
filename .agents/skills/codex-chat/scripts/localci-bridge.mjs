#!/usr/bin/env node

import { CodexChatError } from "./lib/errors.mjs";
import {
  validateBridgeJobFile,
  validateBridgeResultFile,
} from "./lib/localci-bridge.mjs";

const USAGE = [
  "Usage:",
  "  codex-chat-localci-bridge job-validate --file <job.json> --repository <owner/repo> --base-sha <sha> [--default-branch main]",
  "  codex-chat-localci-bridge result-validate --job <job.json> --result <result.json> --repository <owner/repo> --base-sha <sha> [--default-branch main] [--head-sha <sha>] [--pr-number <number>]",
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
    contract(
      invocation.options,
      ["job", "result", "repository", "base-sha"],
      ["default-branch", "head-sha", "pr-number"],
    );
    const job = await validateBridgeJobFile(invocation.options.job, {
      repository: invocation.options.repository,
      baseSha: invocation.options["base-sha"],
      defaultBranch: invocation.options["default-branch"] ?? "main",
    });
    emit(
      invocation.command,
      await validateBridgeResultFile(
        invocation.options.result,
        job,
        {
          headSha: invocation.options["head-sha"] ?? null,
          pullRequestNumber: parsePrNumber(invocation.options["pr-number"]),
        },
      ),
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
