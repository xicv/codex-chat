---
name: codex-chat
description: Coordinate a browser-based external engineering collaborator while Codex remains the accountable lead and independent verifier. Use only when the user explicitly invokes $codex-chat or explicitly asks Codex to delegate a substantial coding, research, design, or review task through the Codex in-app browser without manual copy/paste.
---

# Codex Chat

Use a browser-based external collaborator as an untrusted senior engineer. Codex owns scope, source selection, at-most-once automatic submission, reconciliation, integration, testing, corrections, and the final verdict.

This skill is explicit-only because it can send selected source outside the local machine. Never treat the collaborator's claims as local evidence.

## Establish the boundary

1. Read repository instructions and relevant manifests, architecture documents, source, tests, current branch, and worktree status. Preserve existing changes.
2. Restate the user's functional acceptance criteria and authority. Do not infer permission to commit, push, create a PR, publish, deploy, migrate data, purchase credits, use paid APIs, or handle production data.
3. If external source egress was not authorized by the request or explicit `$codex-chat` invocation, ask once before sending source. Authentication, account selection, CAPTCHA, passkey, password, and two-factor prompts always require the user.
4. Refer to the peer as the **external collaborator**. Treat product/model labels as runtime observations; never hardcode a current marketing name or claim that a visible label proves backend identity.

Read [security.md](references/security.md) before the first outbound turn and [protocol.md](references/protocol.md) before creating a run.

## Prepare deterministic context

Use the bundled helper at `scripts/codex-chat.mjs`. It is a local safety and evidence tool; it never controls the browser or sends messages.

Select explicit UTF-8/LF source files only. Do not pass whole directories.

```bash
node <skill>/scripts/codex-chat.mjs preflight \
  --root "$PWD" \
  --include path/to/file \
  --state-dir "$HOME/.codex/codex-chat/runs"

node <skill>/scripts/codex-chat.mjs pack \
  --root "$PWD" \
  --include path/to/file \
  --output /private/tmp/codex-chat-context.json
```

The helper rejects secrets, sensitive filenames, symlinks, traversal, unsafe text, collisions, and oversized payloads. It scans the exact staged artifact with gitleaks. Report the selected manifest, byte size, SHA-256, and VCS baseline before egress. Send only that exact artifact; rebuilding or broadening it requires a new digest and record.

The output parent must already exist, must be a real directory outside the source root, and the output path must not already exist. The helper never replaces an existing context artifact or source file. The installed CLI always resolves and identity-checks `gitleaks`; it does not accept a scanner override or a scan bypass.

Create the run with the artifact SHA-256, then reserve the one outbound turn:

```bash
node <skill>/scripts/codex-chat.mjs record \
  --run-id <run-id> --event prepared \
  --expected-sequence 0 --expected-state null \
  --data <prepared-data.json>
```

Use the English task structure in [task-template.md](references/task-template.md). Require a bounded `COLLAB_RESULT_V1` response and choose an explicit expected terminal marker. Advisory results contain no patch; patch results remain limited to one existing file.

## Submit at most once and reconcile ambiguity

Prefer the Codex in-app browser using the user's existing authenticated session. Capability-probe the browser before depending on it. A native persisted-chat bridge may observe and reconcile a pending or confirmed turn when available. It may send a new outbound turn only after the prior turn is terminal, conclusively failed, or explicitly resolved by the user. Do not use cookies, private endpoints, browser-profile inspection, paid API fallback, or credit purchase.

Before sending, choose a unique visible outbound marker and record `send_reserved` with expected sequence/state, a permanent idempotency key, turn ID, payload SHA-256, outbound marker, expected terminal marker, and conversation identity. Idempotency keys and outbound markers are bound to their exact operation and cannot be reused for different data. Reconcile the outbound marker first. Send only when the marker is conclusively absent; an unknown observation becomes `send_ambiguous`. After the UI accepts the outbound turn, record `send_confirmed` with the matching turn ID and conversation URL.

Once `send_confirmed` is durable:

- Observe and reconcile only.
- Never resend because of timeout, idle state, missing output, stale status, disconnect, changed reset time, UI refresh, or a long response.
- Associate later partial outputs with the original outbound turn.
- On ambiguous send completion, record `send_ambiguous`; do not guess.
- Save conversation links and terminal markers.

Record transport and allowance observations with their source, observation time, and expiry when known. If both sides are limited, record `suspended_both_limited` with exact resume metadata. If Codex takes over locally, record `local_takeover`; independence is then permanently degraded for that run.

If the observed UI label changes or no longer matches the user-requested collaborator class, do not silently downgrade. Record the observation and either use an explicitly allowed alternative, take over locally with degraded independence, or suspend.

Pause only for authentication, a genuinely material product choice, or an unrecoverable external blocker. Otherwise continue autonomously.

## Review and integrate

After a terminal response:

1. Extract the exact `COLLAB_RESULT_V1` JSON bytes between the response boundary markers and save them unchanged with one final LF. Hash both the full terminal response and those exact envelope bytes. Record `response_terminal` with the active turn ID, expected terminal marker, `responseSha256`, `resultEnvelopeSha256`, and matching conversation identity; then record `review_started`.
2. Validate that exact saved JSON file with `import`; do not reconstruct it or hand-apply an untrusted patch to the working tree. `import` rejects bytes that do not match the durable terminal envelope digest. An advisory result is quarantined, scanned, and receipted without source mutation.
3. For a patch result, apply only to an explicit scratch copy. `import` scans the quarantined result and creates a write-ahead receipt before target replacement. The MVP accepts one existing UTF-8/LF regular file, exact preimage SHA-256, and zero-fuzz unified diff hunks. It rejects creation, deletion, rename, mode, binary, multi-file, stale, symlinked, and out-of-scope changes.
4. Review the postimage independently. Never accept the collaborator's test claims as evidence.
5. Create a `CODEX_CHAT_VERIFY_V1` argv plan, calculate its SHA-256, and run `verify --plan <path> --plan-sha256 <digest> --evidence-dir <path>`. The helper invokes the resolved executable directly with `shell: false`, rejects known direct shells, dispatchers, and inline interpreter evaluation, uses fresh isolated home/temp directories, enforces time/output limits, and writes content-addressed evidence receipts. Dependencies may still launch their own child processes, so Codex must review the plan and repository scripts.
6. Run repository-required lint, type checks, unit, contract, integration, build, and relevant E2E gates. Distinguish synthetic/local evidence from hosted, production, deployment, and device proof.

If evidence fails, send a bounded correction containing exact logs, file locations, constraints, and the smallest requested revision. Start a new reserved outbound turn only from `needs_revision`, never from a pending/ambiguous response. A provider-terminal failure ends the run; an ambiguity that cannot be conclusively reconciled requires a new explicitly authorized run rather than an invented retry transition.

Record `accepted` only after independent gates pass. Otherwise record `needs_revision`, `blocked`, or `human_required`.

## Finish

Persist useful reports and evidence outside temporary browser state. Report:

- collaborator conversation links and observed UI label;
- context baseline, selected files, size, SHA-256, and scanner version;
- actual local changes;
- defects returned for correction;
- exact tests and evidence classes;
- unresolved risks and any degraded independence;
- whether changes are merely local or were committed, pushed, published, or deployed.

Never claim an action outside the recorded authority boundary.
