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
  "  codex-chat-localci-bridge bundle-validate --bundle <file> --job-digest <sha> --source-fingerprint <sha> --result-sha256 <sha>",
  "    --manifest-sha256 <sha> --bridge-main-sha <sha> [--request-pr-number <n>] [--request-head-sha <sha>] [--request-file-sha256 <sha>]",
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
  if (invocation.command === "bundle-validate") {
    const run = bundleValidateCommand(invocation);
    const output = await run();
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
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

// Phase 12: independent bundle validation. Every expected value must be
// supplied independently (--agent-receipt, --bundle-manifest carry the
// OBSERVED artifacts; the expected digests come from the reviewer's own
// queries); nothing is derived from the bundle itself.
function bundleValidateCommand(invocation) {
  const required = ["bundle", "job-digest", "source-fingerprint", "result-sha256", "manifest-sha256", "bridge-main-sha"];
  const optional = ["request-pr-number", "request-head-sha", "request-file-sha256", "job", "config-blob-sha", "request-blob-sha"];
  contractStrict(invocation.options, required, optional);
  return async () => {
    const { validateBridgeJobFile, validateBridgeResult, canonicalBridgeJson } = await import("./lib/localci-bridge.mjs");
    const { readTrustedFileSnapshot } = await import("./lib/trusted-file-snapshot.mjs");
    const { createHash } = await import("node:crypto");

    // 1. Safe bounded read: symlinks and changed-during-read files rejected.
    const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
    const snapshot = await readTrustedFileSnapshot(invocation.options.bundle, { minBytes: 2, maxBytes: MAX_BUNDLE_BYTES });
    const text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);

    // 2. Strict JSON with duplicate-key rejection.
    let value;
    try {
      value = parseStrictJsonNoDuplicates(text);
    } catch (error) {
      throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_INVALID", `Bundle JSON is invalid: ${error.message}`);
    }

    // 3. Exact top-level keys.
    if (value.schema !== "localci-bridge/result-bundle/v1") {
      throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_INVALID", `Unsupported bundle schema ${String(value.schema)}.`);
    }
    const TOP = ["schema", "job_id", "result", "result_sha256", "result_meta", "source_fingerprint", "job_digest", "request_binding_receipt", "bridge_authority_binding", "agent_execution_receipt", "created_at", "producer", "manifest_sha256"];
    assertExactKeys(value, TOP, "bundle");
    const NESTED = {
      result_meta: ["schema", "job_id", "job_digest", "source_fingerprint", "fencing_token", "result_sha256"],
      request_binding_receipt: ["pr_number", "head_sha", "request_file_sha256"],
      bridge_authority_binding: ["main_sha", "config_blob_sha", "request_blob_sha"],
      agent_execution_receipt: ["job_id", "job_digest", "source_fingerprint", "fencing_token", "result_sha256", "execution_mode"],
      producer: ["hostname", "user", "role"],
    };
    for (const [key, keys] of Object.entries(NESTED)) assertExactKeys(value[key], keys, `bundle.${key}`);

    // 4. Recompute the manifest digest (canonical JSON over everything
    // except manifest_sha256) and the canonical result digest.
    const digestOf = (v) => createHash("sha256").update(canonicalBridgeJson(v)).digest("hex");
    const { manifest_sha256, ...rest } = value;
    if (digestOf(rest) !== manifest_sha256) {
      throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_MISMATCH", "manifest_sha256 does not match the recomputed canonical digest.");
    }
    if (digestOf(value.result) !== value.result_sha256) {
      throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_MISMATCH", "result_sha256 does not match the recomputed canonical result digest.");
    }

    // 5. Producer + agent execution receipt.
    if (value.producer.role !== "agent") {
      throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_INVALID", `producer.role must be "agent".`);
    }
    if (value.agent_execution_receipt.job_id !== value.job_id || value.agent_execution_receipt.execution_mode !== "codex-read-only") {
      throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_INVALID", "agent_execution_receipt does not bind this job with read-only execution.");
    }
    if (value.agent_execution_receipt.result_sha256 !== value.result_sha256 || value.agent_execution_receipt.job_digest !== value.job_digest || value.agent_execution_receipt.source_fingerprint !== value.source_fingerprint) {
      throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_INVALID", "agent_execution_receipt digests do not match the manifest.");
    }
    if (value.result_meta.job_id !== value.job_id || value.result_meta.job_digest !== value.job_digest || value.result_meta.source_fingerprint !== value.source_fingerprint || value.result_meta.result_sha256 !== value.result_sha256) {
      throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_INVALID", "result_meta does not match the manifest digests.");
    }

    // 6. Independent comparisons — expected values come ONLY from the CLI.
    const checks = [
      ["job_digest", value.job_digest, invocation.options["job-digest"]],
      ["source_fingerprint", value.source_fingerprint, invocation.options["source-fingerprint"]],
      ["result_sha256", value.result_sha256, invocation.options["result-sha256"]],
      ["manifest_sha256", value.manifest_sha256, invocation.options["manifest-sha256"]],
      ["bridge_authority_binding.main_sha", value.bridge_authority_binding.main_sha, invocation.options["bridge-main-sha"]],
    ];
    for (const [label, actual, expected] of checks) {
      if (actual !== expected) {
        throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_MISMATCH", `bundle.${label} is ${actual}, independently supplied value is ${expected}.`);
      }
    }
    if (invocation.options["request-pr-number"]) {
      const n = parsePrNumber(invocation.options["request-pr-number"]);
      if (value.request_binding_receipt.pr_number !== n) {
        throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_MISMATCH", "bundle.request_binding_receipt.pr_number differs from the independently supplied value.");
      }
    }
    if (invocation.options["request-head-sha"] && value.request_binding_receipt.head_sha !== invocation.options["request-head-sha"]) {
      throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_MISMATCH", "bundle.request_binding_receipt.head_sha differs.");
    }
    if (invocation.options["request-file-sha256"] && value.request_binding_receipt.request_file_sha256 !== invocation.options["request-file-sha256"]) {
      throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_MISMATCH", "bundle.request_binding_receipt.request_file_sha256 differs.");
    }

    // 7. When the sanitized job source is supplied, run the COMPLETE result
    // validator and verify the source fingerprint + embedded bindings.
    let resultVerdict = null;
    if (invocation.options.job) {
      const job = await validateBridgeJobFile(invocation.options.job, {
        repository: value.result.target?.repository ?? "xicv/PeoplePlanner",
        baseSha: value.result.target?.base_sha,
        defaultBranch: "main",
      });
      if (job.job.id !== value.job_id) {
        throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_MISMATCH", "bundle.job_id differs from the supplied job.");
      }
      if (job.digest !== value.job_digest) {
        throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_MISMATCH", "bundle.job_digest differs from the supplied job digest.");
      }
      resultVerdict = validateBridgeResult(value.result, job, {});
      if (resultVerdict.result.source_fingerprint !== value.source_fingerprint) {
        throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_MISMATCH", "The result's embedded source_fingerprint differs from the bundle's.");
      }
      if (invocation.options["config-blob-sha"] && value.result.bridge_binding?.config_blob_sha !== invocation.options["config-blob-sha"]) {
        throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_MISMATCH", "The result's embedded bridge_binding.config_blob_sha differs.");
      }
      if (invocation.options["request-blob-sha"] && value.result.bridge_binding?.request_blob_sha !== invocation.options["request-blob-sha"]) {
        throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_MISMATCH", "The result's embedded bridge_binding.request_blob_sha differs.");
      }
    }

    return {
      schema: "codex-chat/cli/v1",
      ok: true,
      command: "bundle-validate",
      data: {
        job_id: value.job_id,
        result_validated: resultVerdict !== null,
        independently_bound: {
          job_digest: invocation.options["job-digest"],
          source_fingerprint: invocation.options["source-fingerprint"],
          result_sha256: invocation.options["result-sha256"],
          manifest_sha256: invocation.options["manifest-sha256"],
          bridge_main_sha: invocation.options["bridge-main-sha"],
        },
      },
    };
  };
}

function assertExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_INVALID", `${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new CodexChatError("LOCALCI_BRIDGE_BUNDLE_INVALID", `${label} keys must be exactly ${JSON.stringify(expected)}.`);
  }
}

function parseStrictJsonNoDuplicates(text) {
  const seen = new Set();
  const reviver = (key) => {
    if (key !== "" && seen.has(key)) throw new Error(`duplicate key ${JSON.stringify(key)}`);
    seen.add(key);
    return undefined;
  };
  void reviver;
  // JSON.parse revivers cannot see sibling duplicates reliably; use a
  // lightweight scanner over the raw text for duplicate keys per object.
  const stack = [new Set()];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{") { depth += 1; stack.push(new Set()); i += 1; continue; }
    if (ch === "}") { depth -= 1; stack.pop(); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let key = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") { key += text[j + 1]; j += 2; continue; }
        key += text[j];
        j += 1;
      }
      // Only treat as a KEY when followed by ':' at this object level.
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k += 1;
      if (k < text.length && text[k] === ":") {
        if (stack[depth].has(key)) throw new Error(`duplicate key ${JSON.stringify(key)}`);
        stack[depth].add(key);
        i = k + 1;
        continue;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return JSON.parse(text);
}

function contractStrict(options, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new CodexChatError("USAGE", `Unknown option --${name}.`);
  }
  for (const name of required) {
    if (!Object.hasOwn(options, name)) throw new CodexChatError("USAGE", `Missing option --${name}.`);
  }
}
