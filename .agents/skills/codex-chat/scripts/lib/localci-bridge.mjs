import { createHash } from "node:crypto";
import path from "node:path";
import { readTrustedFileSnapshot } from "./trusted-file-snapshot.mjs";
import { fail } from "./errors.mjs";

// Independent reviewer-side validator for LocalCI Bridge job/v1 and
// result/v1 handoffs. This is deliberately a separate implementation from
// the bridge repository itself: it re-derives every structural decision so a
// divergence between the two implementations is visible. The authoritative
// contract lives in the private xicv/localci-bridge repository; the vendored
// schema copies next to this file carry its commit SHA and digests (see
// references/schemas/localci-bridge-authority.json and the divergence test).

const JOB_MAX_BYTES = 128 * 1024;
const RESULT_MAX_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const JOB_ID = /^[a-z0-9][a-z0-9._-]{7,79}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const BRANCH = /^[A-Za-z0-9._/-]+$/u;
const PATH_PATTERN = /^[A-Za-z0-9._/*?-]+$/u;
const SENDER_ALIAS = /^[a-z0-9][a-z0-9 ._-]*$/u;
const RUNNER_NAME = /^[A-Za-z0-9._-]+$/u;
const URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/u;
const FORBIDDEN_PATHS = [
  ".github/workflows/",
  "aws/",
  "deployment/",
  "src/.env",
  "data/",
  "storage/",
];
// Applied to every free-text field.
const SENSITIVE_TEXT = [
  /\bpassword\b\s*[:=]/iu,
  /\b(api[_ -]?key|access[_ -]?token|secret[_ -]?key)\b\s*[:=]/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bghp_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bmessage[_ -]?id\b\s*[:=]/iu,
  /\bthread[_ -]?id\b\s*[:=]/iu,
  /<[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+>/u,
];
// Applied only to sanitized-source fields derived from email.
const SENSITIVE_SOURCE_TEXT = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u,
  /https?:\/\/(mail|drive|docs)\.google\.com/iu,
  /\busercontent\.google\.com\b/iu,
  /^\s*(from|to|cc|bcc|reply-to|in-reply-to|references|delivered-to|received|return-path|message-id|thread-index|content-type|mime-version|subject|date)\s*:/imu,
  /<\/?(?:html|body|head|div|span|table|thead|tbody|tr|td|th|ul|ol|li|p|br|hr|img|a|strong|em|b|i|font|style|script)\b/iu,
  /^\s*--\s*$/mu,
  /\bsent from my /iu,
  /\bbest regards,?\s*$/imu,
  /\battachment[s]?\s*[:=]/iu,
  /\bgmail[_ -]?attachment\b/iu,
];

function looksLikePhoneNumber(value) {
  for (const match of value.matchAll(/\+?\d[\d\s().-]{7,}\d/gu)) {
    const digits = (match[0].match(/\d/gu) || []).length;
    if (digits >= 9 && digits <= 15) return true;
  }
  return false;
}

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("LOCALCI_BRIDGE_OBJECT_INVALID", `${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      "LOCALCI_BRIDGE_KEYS_INVALID",
      `${label} has missing or unexpected fields.`,
      { actual, expected },
    );
  }
  return value;
}

function stringField(value, label, { min = 1, max = 1000, pattern = null } = {}) {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    value.includes("\0") ||
    (pattern !== null && !pattern.test(value))
  ) {
    fail("LOCALCI_BRIDGE_STRING_INVALID", `${label} is invalid.`);
  }
  return value;
}

function enumField(value, allowed, label) {
  if (!allowed.includes(value)) {
    fail(
      "LOCALCI_BRIDGE_ENUM_INVALID",
      `${label} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

function integerField(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(
      "LOCALCI_BRIDGE_INTEGER_INVALID",
      `${label} must be an integer from ${min} to ${max}.`,
    );
  }
  return value;
}

function booleanField(value, expected, label) {
  if (value !== expected) {
    fail(
      "LOCALCI_BRIDGE_BOOLEAN_INVALID",
      `${label} must be ${expected}.`,
    );
  }
  return value;
}

function utcTimestamp(value, label) {
  stringField(value, label, { max: 64 });
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(
      "LOCALCI_BRIDGE_DATE_INVALID",
      `${label} must be a canonical UTC ISO timestamp.`,
    );
  }
  return value;
}

function rejectSensitiveText(value, label, { source = false } = {}) {
  const patterns = source
    ? [...SENSITIVE_TEXT, ...SENSITIVE_SOURCE_TEXT]
    : SENSITIVE_TEXT;
  if (patterns.some((pattern) => pattern.test(value))) {
    fail(
      "LOCALCI_BRIDGE_SENSITIVE_TEXT",
      `${label} appears to contain a secret, raw mailbox identifier, contact detail, or unsanitized email content.`,
    );
  }
  if (looksLikePhoneNumber(value)) {
    fail("LOCALCI_BRIDGE_SENSITIVE_TEXT", `${label} appears to contain a phone number.`);
  }
}

function normalizeCanonical(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(
        "LOCALCI_BRIDGE_JSON_NUMBER_INVALID",
        "JSON numbers must be finite.",
      );
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeCanonical(value[key])]),
    );
  }
  fail(
    "LOCALCI_BRIDGE_JSON_VALUE_INVALID",
    "Value cannot be represented as canonical JSON.",
  );
}

export function canonicalBridgeJson(value) {
  return `${JSON.stringify(normalizeCanonical(value))}\n`;
}

export function bridgeDigest(value) {
  return createHash("sha256").update(canonicalBridgeJson(value)).digest("hex");
}

// The bridge recomputes this from normalized source fields and requires exact
// equality; the reviewer-side validator does the same independently.
export function bridgeSourceFingerprint(source) {
  exactObject(source, ["kind", "subject", "sender_alias", "received_at", "summary"], "source");
  enumField(source.kind, ["gmail", "github", "manual"], "source.kind");
  stringField(source.subject, "source.subject", { max: 200 });
  stringField(source.sender_alias, "source.sender_alias", { min: 2, max: 64, pattern: SENDER_ALIAS });
  utcTimestamp(source.received_at, "source.received_at");
  stringField(source.summary, "source.summary", { max: 3000 });
  const normalized = {
    kind: source.kind.trim().toLowerCase(),
    subject: source.subject.trim().replace(/\s+/gu, " ").toLowerCase(),
    sender_alias: source.sender_alias.trim().replace(/\s+/gu, " ").toLowerCase(),
    received_at: source.received_at,
    summary: source.summary.trim().replace(/\s+/gu, " "),
  };
  return createHash("sha256").update(canonicalBridgeJson(normalized)).digest("hex");
}

async function readBridgeJson(filePath, maxBytes, label) {
  const snapshot = await readTrustedFileSnapshot(filePath, {
    minBytes: 2,
    maxBytes,
  });
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
  } catch {
    fail(
      "LOCALCI_BRIDGE_UTF8_INVALID",
      `${label} must be valid UTF-8.`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(
      "LOCALCI_BRIDGE_JSON_INVALID",
      `${label} is not valid JSON: ${error.message}`,
    );
  }
}

function validateAllowedPathValue(value) {
  stringField(value, "allowed path", { max: 240, pattern: PATH_PATTERN });
  if (value === "**" || value === "*" || value === "*/**") {
    fail("LOCALCI_BRIDGE_PATH_INVALID", "Catch-all allowed paths are forbidden.");
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized.startsWith("../") || value.includes("**/**")) {
    fail("LOCALCI_BRIDGE_PATH_INVALID", `Allowed path is not canonical: ${value}`);
  }
  if (FORBIDDEN_PATHS.some((prefix) => value === prefix.replace(/\/$/u, "") || value.startsWith(prefix))) {
    fail("LOCALCI_BRIDGE_PATH_INVALID", `Allowed path overlaps a protected area: ${value}`);
  }
}

export function validateBridgeJob(value, expectations) {
  exactObject(value, [
    "schema", "id", "created_at", "source", "target", "task_type", "mode",
    "priority", "instructions", "acceptance_criteria", "allowed_paths",
    "verification_profile", "timeout_minutes", "publish",
  ], "job");
  if (value.schema !== "localci-bridge/job/v1") {
    fail("LOCALCI_BRIDGE_SCHEMA_INVALID", "Unsupported job schema.");
  }
  stringField(value.id, "job.id", { min: 8, max: 80, pattern: JOB_ID });
  utcTimestamp(value.created_at, "job.created_at");

  exactObject(value.source, [
    "kind", "fingerprint", "subject", "sender_alias", "received_at", "summary",
  ], "job.source");
  stringField(value.source.fingerprint, "source.fingerprint", { min: 64, max: 64, pattern: SHA256 });
  for (const [label, text] of [
    ["subject", value.source.subject],
    ["sender alias", value.source.sender_alias],
    ["summary", value.source.summary],
  ]) {
    rejectSensitiveText(text, `source ${label}`, { source: true });
  }
  if (bridgeSourceFingerprint({
    kind: value.source.kind,
    subject: value.source.subject,
    sender_alias: value.source.sender_alias,
    received_at: value.source.received_at,
    summary: value.source.summary,
  }) !== value.source.fingerprint) {
    fail(
      "LOCALCI_BRIDGE_FINGERPRINT_MISMATCH",
      "source.fingerprint does not equal the fingerprint recomputed from normalized source fields.",
    );
  }

  exactObject(value.target, ["repository", "base_sha", "default_branch"], "job.target");
  stringField(value.target.repository, "target.repository", { max: 200, pattern: REPOSITORY });
  stringField(value.target.base_sha, "target.base_sha", { min: 40, max: 40, pattern: COMMIT_SHA });
  stringField(value.target.default_branch, "target.default_branch", { max: 100, pattern: BRANCH });
  if (value.target.repository !== expectations.repository) {
    fail("LOCALCI_BRIDGE_TARGET_MISMATCH", "Job target repository differs from the independently supplied repository.");
  }
  if (value.target.base_sha !== expectations.baseSha) {
    fail("LOCALCI_BRIDGE_TARGET_MISMATCH", "Job base SHA differs from the independently supplied base SHA.");
  }
  if (value.target.default_branch !== expectations.defaultBranch) {
    fail("LOCALCI_BRIDGE_TARGET_MISMATCH", "Job default branch differs from the independently supplied branch.");
  }

  enumField(value.task_type, ["triage-report", "draft-pr"], "job.task_type");
  enumField(value.mode, ["read-only", "workspace-write"], "job.mode");
  if (value.task_type === "triage-report" && value.mode !== "read-only") {
    fail("LOCALCI_BRIDGE_MODE_INVALID", "Triage reports must be read-only.");
  }
  if (value.task_type === "draft-pr" && value.mode !== "workspace-write") {
    fail("LOCALCI_BRIDGE_MODE_INVALID", "Draft PR jobs require workspace-write mode.");
  }
  enumField(value.priority, ["regression", "security", "bug", "performance", "feature", "documentation"], "job.priority");

  stringField(value.instructions, "job.instructions", { max: 12000 });
  rejectSensitiveText(value.instructions, "instructions");

  if (!Array.isArray(value.acceptance_criteria) || value.acceptance_criteria.length < 1 || value.acceptance_criteria.length > 30) {
    fail("LOCALCI_BRIDGE_ACCEPTANCE_INVALID", "acceptance_criteria must be a bounded non-empty array.");
  }
  for (const item of value.acceptance_criteria) {
    stringField(item, "acceptance criterion", { max: 1000 });
    rejectSensitiveText(item, "acceptance criterion");
  }

  if (!Array.isArray(value.allowed_paths) || value.allowed_paths.length > 40) {
    fail("LOCALCI_BRIDGE_PATH_INVALID", "allowed_paths is invalid.");
  }
  if (new Set(value.allowed_paths).size !== value.allowed_paths.length) {
    fail("LOCALCI_BRIDGE_PATH_INVALID", "allowed_paths must be unique.");
  }
  for (const item of value.allowed_paths) validateAllowedPathValue(item);
  if (value.task_type === "draft-pr" && value.allowed_paths.length < 1) {
    fail("LOCALCI_BRIDGE_PATH_INVALID", "Draft PR jobs require at least one allowed path.");
  }
  if (value.task_type === "triage-report" && value.allowed_paths.length !== 0) {
    fail("LOCALCI_BRIDGE_PATH_INVALID", "Read-only triage jobs cannot allow file changes.");
  }

  stringField(value.verification_profile, "job.verification_profile", { min: 3, max: 64, pattern: /^[a-z][a-z0-9-]+$/u });
  integerField(value.timeout_minutes, "job.timeout_minutes", 5, 120);

  exactObject(value.publish, ["target_draft_pr", "merge", "deploy", "release"], "job.publish");
  for (const key of ["merge", "deploy", "release"]) {
    if (value.publish[key] !== false) {
      fail("LOCALCI_BRIDGE_PUBLICATION_INVALID", `publish.${key} must be false; the bridge never grants merge, deploy, or release authority.`);
    }
  }
  const expectedDraftPr = value.task_type === "draft-pr";
  if (value.publish.target_draft_pr !== expectedDraftPr) {
    fail(
      "LOCALCI_BRIDGE_PUBLICATION_INVALID",
      `publish.target_draft_pr must be ${expectedDraftPr} for ${value.task_type} jobs; read-only triage never implies a target code PR.`,
    );
  }

  return Object.freeze({
    valid: true,
    jobId: value.id,
    digest: bridgeDigest(value),
    job: value,
  });
}

export async function validateBridgeJobFile(filePath, expectations) {
  return validateBridgeJob(
    await readBridgeJson(filePath, JOB_MAX_BYTES, "job"),
    expectations,
  );
}

export function validateBridgeResult(value, job, identity = {}) {
  const { headSha = null, pullRequestNumber = null } = identity;
  exactObject(value, [
    "schema", "job_id", "job_fingerprint", "completed_at", "status", "target",
    "pull_request", "verification", "release_recommendation", "safety",
  ], "result");
  if (value.schema !== "localci-bridge/result/v1") {
    fail("LOCALCI_BRIDGE_SCHEMA_INVALID", "Unsupported result schema.");
  }
  if (value.job_id !== job.job.id) {
    fail("LOCALCI_BRIDGE_RESULT_JOB_MISMATCH", "Result job ID does not match the job.");
  }
  if (value.job_fingerprint !== job.digest) {
    fail("LOCALCI_BRIDGE_RESULT_DIGEST_MISMATCH", "Result job fingerprint does not match the job.");
  }
  utcTimestamp(value.completed_at, "result.completed_at");
  enumField(value.status, ["no-action", "blocked", "draft-pr-open", "failed"], "result.status");

  exactObject(value.target, ["repository", "base_sha", "head_sha"], "result.target");
  if (value.target.repository !== job.job.target.repository || value.target.base_sha !== job.job.target.base_sha) {
    fail("LOCALCI_BRIDGE_RESULT_TARGET_MISMATCH", "Result target does not match the job.");
  }
  if (value.target.head_sha !== null) {
    stringField(value.target.head_sha, "result.target.head_sha", { min: 40, max: 40, pattern: COMMIT_SHA });
  }

  if (value.pull_request !== null) {
    if (job.job.task_type !== "draft-pr") {
      fail(
        "LOCALCI_BRIDGE_RESULT_PR_INVALID",
        "Only draft-pr jobs may report a target pull request; read-only triage publishes a report, not a code PR.",
      );
    }
    exactObject(value.pull_request, ["number", "url", "draft", "mergeability", "ci_state"], "result.pull_request");
    integerField(value.pull_request.number, "pull_request.number", 1, Number.MAX_SAFE_INTEGER);
    const match = URL.exec(value.pull_request.url);
    if (match === null || `${match[1]}/${match[2]}` !== job.job.target.repository || Number(match[3]) !== value.pull_request.number) {
      fail(
        "LOCALCI_BRIDGE_RESULT_URL_MISMATCH",
        `pull_request.url must be exactly https://github.com/${job.job.target.repository}/pull/${value.pull_request.number}.`,
      );
    }
    if (value.pull_request.draft !== true) {
      fail("LOCALCI_BRIDGE_RESULT_PR_INVALID", "pull_request.draft must be true; results may only report draft PRs.");
    }
    enumField(value.pull_request.mergeability, ["mergeable", "conflicting", "unknown"], "pull_request.mergeability");
    enumField(value.pull_request.ci_state, ["pending", "success", "failure", "unknown"], "pull_request.ci_state");
  }
  if (value.status === "draft-pr-open" && (value.pull_request === null || value.target.head_sha === null)) {
    fail("LOCALCI_BRIDGE_RESULT_PR_INVALID", "Draft PR results require PR and head SHA evidence.");
  }
  if (value.status !== "draft-pr-open" && value.pull_request !== null) {
    fail("LOCALCI_BRIDGE_RESULT_PR_INVALID", "Only draft-pr-open results may contain a pull request.");
  }
  if (headSha !== null && value.target.head_sha !== null && value.target.head_sha !== headSha) {
    fail(
      "LOCALCI_BRIDGE_RESULT_HEAD_MISMATCH",
      "Result head SHA differs from the independently supplied current head SHA.",
    );
  }
  if (pullRequestNumber !== null && value.pull_request !== null && value.pull_request.number !== pullRequestNumber) {
    fail(
      "LOCALCI_BRIDGE_RESULT_PR_MISMATCH",
      "Result PR number differs from the independently supplied PR number.",
    );
  }

  if (!Array.isArray(value.verification) || value.verification.length > 30) {
    fail("LOCALCI_BRIDGE_VERIFICATION_INVALID", "Verification evidence is invalid.");
  }
  for (const check of value.verification) {
    exactObject(check, [
      "name", "status", "evidence", "github_run_id", "github_job_id",
      "runner_name", "artifact_sha256",
    ], "verification check");
    stringField(check.name, "verification.name", { max: 120 });
    enumField(check.status, ["success", "failure", "skipped", "pending"], "verification.status");
    stringField(check.evidence, "verification.evidence", { min: 0, max: 1000 });
    for (const [key, id] of [["github_run_id", check.github_run_id], ["github_job_id", check.github_job_id]]) {
      if (id !== null) integerField(id, `verification.${key}`, 1, Number.MAX_SAFE_INTEGER);
    }
    if (check.runner_name !== null) stringField(check.runner_name, "verification.runner_name", { max: 120, pattern: RUNNER_NAME });
    if (check.artifact_sha256 !== null) stringField(check.artifact_sha256, "verification.artifact_sha256", { min: 64, max: 64, pattern: SHA256 });
    if (check.status === "success") {
      const codexLane = typeof check.runner_name === "string" && check.runner_name.startsWith("codex");
      if (codexLane) {
        if (check.artifact_sha256 === null) {
          fail("LOCALCI_BRIDGE_VERIFICATION_INVALID", "Successful codex-lane evidence must include the report artifact digest.");
        }
      } else {
        if (check.github_run_id === null || check.runner_name === null) {
          fail("LOCALCI_BRIDGE_VERIFICATION_INVALID", "Successful verification evidence must bind the GitHub workflow run and runner identity.");
        }
        if (check.github_job_id === null && check.artifact_sha256 === null) {
          fail("LOCALCI_BRIDGE_VERIFICATION_INVALID", "Successful verification evidence must include the GitHub job id or an artifact digest.");
        }
      }
    }
  }

  enumField(value.release_recommendation, ["do-not-release", "needs-new-mac-review", "blocked"], "release_recommendation");
  if (value.release_recommendation === "needs-new-mac-review" && value.status !== "draft-pr-open") {
    fail("LOCALCI_BRIDGE_RECOMMENDATION_INVALID", "Only a draft PR can request new-Mac review.");
  }

  exactObject(value.safety, ["gmail_mutated", "merged", "deployed", "released", "production_accessed"], "result.safety");
  for (const [key, field] of Object.entries(value.safety)) {
    booleanField(field, false, `result.safety.${key}`);
  }

  return Object.freeze({
    valid: true,
    jobId: value.job_id,
    pullRequestNumber: value.pull_request === null ? null : value.pull_request.number,
    actionAuthorized: false,
    mergeAuthorized: false,
    releaseAuthorized: false,
    result: value,
  });
}

export async function validateBridgeResultFile(filePath, job, identity) {
  return validateBridgeResult(
    await readBridgeJson(filePath, RESULT_MAX_BYTES, "result"),
    job,
    identity,
  );
}
