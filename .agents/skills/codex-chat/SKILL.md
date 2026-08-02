---
name: codex-chat
description: Coordinate a browser-based external engineering collaborator while Codex remains the accountable lead and independent verifier, using the Codex in-app Browser first and an installed Ego Browser only as a bounded pre-send fallback. Use only when the user explicitly invokes $codex-chat or explicitly asks Codex to delegate a substantial coding, research, design, or review task without manual copy/paste.
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

## Prove browser transport before source work

Before selecting outbound files, packing, scanning, creating a run, or
reserving a send, establish a zero-source-egress browser and
provider-readiness gate. The built-in Browser is the primary transport. Ego
Browser is the only permitted alternative, and only when the primary is
conclusively unavailable before any source or send action. Do not use Chrome,
another browser surface, an API, or a manual copy/paste relay as another
fallback.

1. Claim the app-wide transport probe before discovering or calling the
   built-in Browser tool:

   ```bash
   node <skill>/scripts/codex-chat.mjs transport-gate --action claim
   ```

   Keep the returned `claimToken`. If `probeAllowed` is false, do not call
   `node_repl/js`. A `same_host_generation_failed` result means the exact
   browser-host generation already returned `Transport closed` and no verified
   host restart has occurred; `desktop_generation_unsupported` or
   `desktop_host_not_ready` means the primary cannot pass this gate. These are
   conclusive primary unavailability classifications for this attempt. A
   `probe_in_progress` result instead means another coordinator owns the
   bounded primary health probe: report it and stop without starting Ego,
   because a second browser writer could cross the active coordinator.
2. Follow the installed Browser skill to expose `node_repl/js` through tool
   discovery. Run one no-I/O probe:

   ```js
   nodeRepl.write("CODEX_CHAT_TRANSPORT_OK")
   ```
3. Initialize the supported browser runtime, acquire the intended browser
   binding, read its complete documentation, and perform one supported
   read-only capability check.
4. Open or claim the intended external collaborator conversation and use a
   fresh read-only page observation to verify that its authenticated composer
   is ready. Record the provider namespace, a unique logical conversation
   identity, the observed UI label, and any stable locator that is already
   available. Do not route by the page title or model label. Do not type,
   paste, attach, upload, or send anything.
5. After the read-only browser and provider checks succeed, close the claimed
   transport circuit with:

   ```bash
   node <skill>/scripts/codex-chat.mjs transport-gate \
     --action success \
     --claim-token <claim-token>
   ```
6. Only after the provider-readiness check passes may source selection and
   capsule preparation begin.

If the built-in Browser skill or `node_repl/js` cannot be exposed, or its
supported runtime or read-only capability cannot initialize, release an active
claim without recording false health:

```bash
node <skill>/scripts/codex-chat.mjs transport-gate \
  --action release \
  --claim-token <claim-token>
```

This neutral release permits the Ego fallback without leaving a two-minute
claim or marking the browser host healthy or failed.

If `node_repl/js` returns `Transport closed` during this gate, reacquire
`node_repl/js` through tool discovery once and repeat only the no-I/O probe. Do
not call `js_reset`; reset uses the same closed transport. Do not switch to
another `node_repl`-backed surface or loop retries. If the second probe fails,
trip the claimed circuit:

```bash
node <skill>/scripts/codex-chat.mjs transport-gate \
  --action failure \
  --claim-token <claim-token>
```

This durable record suppresses every later probe from every coordinator sharing
the same desktop login until `codex-code-mode-host` has a different process
generation. Preserve the exact error and recorded ChatGPT and browser-host
PIDs/start times so a full restart is verifiable rather than assumed. If Ego
is unavailable, recommend quitting and reopening the app after other active
tasks finish—a full restart of the ChatGPT desktop app—before a later primary
attempt.

After one of the conclusive primary-unavailability classifications above,
read [ego-browser.md](references/ego-browser.md). Before invoking Ego, acquire
the local Ego bootstrap lease described there using the already-chosen
workspace, coordinator, work-unit, agent, and attempt identities. If another
coordinator owns the unexpired lease, stop without waiting, retrying, creating
a task space, or preparing source. The lease capability remains local to the
controller and is never passed into a browser command or external context.
Only its owner may renew or release it.

Hold that lease through the single read-only readiness attempt, run creation,
and source preparation. Release it only after the normal provider-conversation
lease is durably acquired by `send_reserved`, or after the Ego attempt has
stopped and no Ego browser operation remains in flight. This closes the
pre-run interval where no conversation identity exists yet. Renew before the
lease expires; an expired or mismatched capability stops the attempt instead
of authorizing another browser action.

Make the single read-only readiness attempt only when the installed Ego skill
and CLI are available.
The user owns Ego installation and every authentication or verification
action. Do not install software, inspect credentials, or automate login. If
Ego is unavailable or its one attempt fails, stop before source preparation
and report the primary and Ego observations, that no capsule was prepared or
transmitted, and that there are no external collaborator claims.

Ego readiness must classify the composer before source work because ChatGPT
can restore an account-level draft into a new task space. Preserve any
inherited draft untouched and make at most one source-free attempt to open and
verify a distinct empty tab. A passing fallback binds both the numeric task
space and exact browser target for the entire run. Never ask the user to submit
an unknown draft. Use the exact installed skill directory when importing the
strict local `scripts/lib/ego-readiness.mjs` decision core; do not recreate its
readiness or cleanup decisions inside the browser script.

If provider readiness fails for any other reason, stop before source
preparation. If the browser transport itself was proven healthy, complete the
claimed circuit with `--action success` before reporting the observed provider
or authentication blocker, that no capsule was prepared or transmitted, and
that there are no external collaborator claims. Authentication and
verification challenges remain user-only actions.

Bind the selected transport for the complete run. Reuse its browser binding,
conversation identity, and coordinator route; do not switch transports for a
correction, timeout, disconnect, or changed UI. If the selected transport fails
after selection, stop and preserve the current run state.

This fallback classification applies only while no upload or send UI action has
been invoked. If any action might have uploaded or submitted content, never
start the Ego fallback. Apply the ambiguity rules below, preserve the visible
marker, record or preserve `send_ambiguous`, and never infer non-delivery or
resend through another transport.

## Prepare deterministic context

After the browser transport gate passes, use the bundled helper at
`scripts/codex-chat.mjs`. It is a local safety and evidence tool; it never
controls the browser or sends messages.

For the portable v1 capsule, select explicit UTF-8/LF source files only. Do
not pass whole directories.

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

The helper rejects secrets, sensitive filenames, symlinks, traversal, unsafe text, collisions, and oversized payloads. It scans the exact staged artifact with gitleaks from an isolated policy directory after removing parent `GITLEAKS_*` configuration and disabling payload-controlled allow comments and ignore files. Report the selected manifest, byte size, SHA-256, and VCS baseline before egress. Send only that exact artifact; rebuilding or broadening it requires a new digest and record.

The output parent must already exist, must be a real directory outside the source root, and the output path must not already exist. The helper never replaces an existing context artifact or source file. The installed CLI always resolves and identity-checks `gitleaks`; it does not accept a scanner override or a scan bypass.

Persist the exact task envelope as a UTF-8/LF file, then create a size-aware
transport manifest before run creation:

```bash
node <skill>/scripts/codex-chat.mjs transport-plan \
  --root "$PWD" \
  --context /private/tmp/codex-chat-context.json \
  --context-sha256 <context-sha256> \
  --task-envelope /private/tmp/codex-chat-task.txt \
  --task-envelope-sha256 <task-envelope-sha256> \
  --transport-kind <selected-transport> \
  --upload-capability <available|unavailable|unknown> \
  --output /private/tmp/codex-chat-transport.json
```

Set upload capability to `available` only after the already-selected transport
has exposed a supported upload control in a read-only capability observation.
The helper re-reads, digest-checks, and secret-scans the exact context, task,
and generated manifest. Small contexts become one exact inline composer
envelope. Larger contexts select one attachment only when upload is available;
otherwise the plan stops before run creation or browser mutation. Oversized
task instructions always stop. Bind the returned manifest SHA-256 as
`transportManifestSha256` in hardened `prepared` and `send_reserved` events.

The manifest's `composer.text` is the only planned composer text. For an
attachment strategy, upload only the exact context digest at ordinal zero and
then compose that exact text. `reservationEligible` permits creating the
durable reservation; it is not send authority. Every plan keeps
`actionAuthorized: false`, `resendAuthorized: false`, and
`modelVisible: "unknown"`. The browser adapter may perform its one planned
action only after `send_reserved` is durable. A missing or ambiguous upload
result never authorizes another upload or a send without the required context.

When code, text, images, PDFs, documents, spreadsheets, data, or lossy
derivatives must be related, create a `CODEX_CHAT_MANIFEST_PLAN_V2` and run:

```bash
node <skill>/scripts/codex-chat.mjs manifest \
  --root "$PWD" \
  --plan /private/tmp/codex-chat-manifest-plan.json \
  --output /private/tmp/codex-chat-manifest.json
```

The manifest scans every exact representation plus the sidecar, records
source/derivative digests and transformation provenance, and initializes every
delivery as `modelVisible: "unknown"`. It does not upload attachments. Never
claim an image, page render, embedded visual, formula, or data range was
model-visible from a manifest.

After a transport has produced observable attachment evidence, create a
`CODEX_CHAT_DELIVERY_RECEIPT_PLAN_V2` and run:

```bash
node <skill>/scripts/codex-chat.mjs delivery-receipt \
  --state-dir /private/tmp/codex-chat-runs \
  --run-id <run-id> \
  --manifest /private/tmp/codex-chat-manifest.json \
  --plan /private/tmp/codex-chat-delivery-plan.json \
  --evidence /private/tmp/codex-chat-provider-evidence.bin
```

The scanned receipt is created only for a durable coordinated run whose
outbound turn is already confirmed. One plan binds one manifest
representation and zero-based attachment ordinal to the exact current ledger
sequence/hash, route, conversation, turn, transport locator, observation time,
provider evidence, and raw evidence bytes. Provider fingerprints are preferred
to raw identifiers because all input and output evidence is secret-scanned.
The helper owns the create-only receipt and slot paths beneath the run state
directory. An identical replay is idempotent; a different claim for the same
slot fails closed. It never mutates the manifest or ledger, uploads an
attachment, records acceptance of the work, or authorizes resend. Transport
acceptance still leaves `modelVisible: "unknown"`; a future append-only
visibility artifact may refine that observation without rewriting existing
evidence. Read
[coordination-v2.md](references/coordination-v2.md) before using more than one
agent or coordinator.

When coordinators or agents run on different hosts, do not approximate shared
state with conversation titles, copied "latest" messages, several local state
directories, or a network filesystem. Start one authoritative distributed
control plane and read
[distributed-coordination-v1.md](references/distributed-coordination-v1.md):

```bash
node <skill>/scripts/codex-chat.mjs control-serve \
  --state-dir /var/lib/codex-chat/control \
  --host 127.0.0.1 \
  --port 9443

node <skill>/scripts/codex-chat.mjs control \
  --endpoint http://127.0.0.1:9443 \
  --request /private/tmp/coordination-request.json
```

Non-loopback listeners require TLS; client certificates are optional and can
be required. Pre-populate the environment from the deployment's secret
manager. Pass the bearer token only through
`CODEX_CHAT_CONTROL_TOKEN`, never an argument, task envelope, browser page, or
external collaborator message.

For one distributed run: acquire an epoch lease; append the exact distributed
run head; claim any provider conversation; enqueue work on the complete
workspace/coordinator/run/work-unit/agent route; claim with a visibility
timeout; acknowledge, cancel, or prune finalized work; and renew or release
the lease. Every mutation has a permanent idempotency key. Every state-changing
operation after acquisition carries the current owner, lease ID, and fencing
token. A takeover must reconcile local evidence and pending sends before doing
new work.

The authority is one durable single-writer process. It supports clients on
several hosts but is not replicated consensus or automatic host failover. If
it is unavailable, pause rather than creating a second authority. Its bearer
token is a trusted-domain credential, not per-agent authorization; never give
it to an untrusted external model.

Create the run with the context artifact SHA-256 and the SHA-256 of the exact
English task envelope that will be sent, then reserve the one outbound turn.
New runs use `outboundBindingVersion: 2`. For a coordinated run, `prepared`
also includes immutable `routing` (`workspaceId`, `coordinatorId`,
`workUnitId`) plus `requiredGates`; `send_reserved` repeats the context and task
digests, provider namespace, route, and adds one `agentId`:

```bash
node <skill>/scripts/codex-chat.mjs record \
  --run-id <run-id> --event prepared \
  --expected-sequence 0 --expected-state null \
  --data <prepared-data.json>
```

Use the English task structure in [task-template.md](references/task-template.md). Require a bounded `COLLAB_RESULT_V1` response and choose an explicit expected terminal marker. Advisory results contain no patch; patch results remain limited to one existing file.

## Submit at most once and reconcile ambiguity

Use the one transport selected by the zero-egress gate: normally the Codex
in-app Browser, or the bound Ego task space after a conclusive primary outage.
A native persisted-chat bridge may observe and reconcile a pending or
confirmed turn when available. It may send a new outbound turn only after the
prior turn is terminal, conclusively failed, or explicitly resolved by the
user. Do not switch browser transports after selection or use cookies, private
endpoints, browser-profile inspection, paid API fallback, or credit purchase.

Before sending, choose a unique visible outbound marker and record
`send_reserved` with expected sequence/state, a permanent idempotency key, turn
ID, context SHA-256, exact task-envelope SHA-256, outbound marker, expected
terminal marker, provider namespace, conversation identity, and any active
route. The helper takes a local lease on that provider conversation. Reconcile
the outbound marker first. Send only when the marker is conclusively absent; an
unknown observation becomes `send_ambiguous`. After the UI accepts the outbound
turn, record `send_confirmed`. A coordinated confirmation repeats the full
route, marker, conversation identity, provider namespace, transport, canonical
locator, observation time, evidence class, and provider-message fingerprint
when observable; confirmation leases that locator too. Idempotency keys and
outbound markers are bound to their exact operation and cannot be reused for
different data. Do not route by conversation title or model label.

Read the bound transport manifest again immediately before browser mutation.
Its digest must match the run, its strategy must not be `stop`, and its exact
`composer.text` must still match the recorded composer digest. For an
attachment strategy, the exact context artifact and ordinal must match too.
Never improvise a different inline/attachment choice after reservation.

For the bound Ego transport, follow
[ego-browser.md](references/ego-browser.md#submit-one-bound-turn) exactly. Keep
the marker and task envelope durable outside each browser process; classify the
existing composer before mutation; never use `fillInput` for ChatGPT's
contenteditable or clear an unknown draft; reselect the exact bound target
before every command; and split exact composition, one explicit send-button
click, and read-only observation into separate bounded heredocs. Missing
command output triggers marker reconciliation, never resend.

Once `send_confirmed` is durable:

- Observe and reconcile only.
- Never resend because of timeout, idle state, missing output, stale status, disconnect, changed reset time, UI refresh, or a long response.
- Associate later partial outputs with the original outbound turn.
- On ambiguous send completion, record `send_ambiguous`; do not guess.
- Save conversation links and terminal markers.

Before sending, set an external-response observation budget appropriate to the
task's expected depth. This is a local-progress deadline, never a delivery
timeout. When the budget expires, perform one read-only reconciliation. If
exactly one submitted marker remains visible, the response is still
non-terminal, and no provider-terminal failure is visible, record
`local_takeover` with the elapsed time and observation evidence; the response
remains pending and observe-only, and independence stays degraded for the run.
Do not cancel the provider generation, click Stop, resend, switch transports,
close the bound task space, or record a terminal response. Continue local work
without waiting on the provider, and opportunistically observe the original
turn when doing so does not block the user. If it later becomes terminal,
capture and review it normally without restoring independence retroactively.

Record transport and allowance observations with their source, observation
time, and expiry when known. Noncritical equivalent observations may set
`coalesce: true`; repeats within five seconds do not grow the ledger. Use
`recovery-plan` when a persistent adapter needs a deterministic read-only
reconciliation contract. If both sides are limited, record
`suspended_both_limited` with exact resume metadata. If Codex takes over
locally, record `local_takeover`; independence is then permanently degraded for
that run.

If the observed UI label changes or no longer matches the user-requested collaborator class, do not silently downgrade. Record the observation and either use an explicitly allowed alternative, take over locally with degraded independence, or suspend.

Pause only for authentication, a genuinely material product choice, or an unrecoverable external blocker. Otherwise continue autonomously.

## Review and integrate

After a terminal response:

1. Save the complete terminal response unchanged, then extract the exact
   `COLLAB_RESULT_V1` JSON bytes between the response boundary markers and save
   them unchanged with one final LF. Run `terminal-capture --capture <full>
   --result <json>` to verify, secret-scan, and publish create-once response,
   envelope, receipt, and slot evidence. Record `response_terminal` using the
   returned `eventData`; do not hand-author hash claims. Then record
   `review_started`. The helper revalidates the stored evidence at review,
   import, and acceptance.

   ```bash
   node <skill>/scripts/codex-chat.mjs terminal-capture \
     --state-dir /private/tmp/codex-chat-runs \
     --run-id <run-id> \
     --capture /private/tmp/codex-chat-terminal-response.txt \
     --result /private/tmp/codex-chat-result.json
   ```
   If the exact boundary bytes fail only `COLLAB_RESULT_V1` validation, rerun
   the same immutable capture with `--result-mode rejected`. This mode must
   reproduce one exact `RESULT_*` error. Record the returned
   `response_rejected` event data, which enters correction-only
   `needs_revision`; do not start review, import, verification, or acceptance,
   and never edit or reconstruct the collaborator's malformed envelope.
2. Validate that exact saved JSON file with `import`; do not reconstruct it or hand-apply an untrusted patch to the working tree. `import` rejects bytes that do not match the durable terminal envelope digest. An advisory result is quarantined, scanned, and receipted without source mutation.
3. For a patch result, apply only to an explicit scratch copy. `import` scans the quarantined result, serializes by canonical scratch target, creates a write-ahead receipt, and performs a final no-follow inode/preimage comparison before target replacement. The MVP accepts one existing UTF-8/LF regular file, exact preimage SHA-256, and zero-fuzz unified diff hunks. It rejects creation, deletion, rename, mode, binary, multi-file, stale, symlinked, raced, and out-of-scope changes.
4. Review the postimage independently. Never accept the collaborator's test claims as evidence.
5. Create a `CODEX_CHAT_VERIFY_V1` argv plan, calculate its SHA-256, and run `verify --plan <path> --plan-sha256 <digest> --evidence-dir <path>`. For coordinated work, bind the plan to run, turn, context, route, gate, application key, and postimage. The helper invokes the resolved executable directly with `shell: false`, rejects known direct shells, dispatchers, and inline interpreter evaluation, uses fresh isolated home/temp directories, enforces time/output limits, and writes content-addressed terminal evidence receipts. Dependencies may still launch their own child processes, so Codex must review the plan and repository scripts.
6. Run repository-required lint, type checks, unit, contract, integration, build, and relevant E2E gates. Distinguish synthetic/local evidence from hosted, production, deployment, and device proof.

If evidence fails, send a bounded correction containing exact logs, file locations, constraints, and the smallest requested revision. Start a new reserved outbound turn only from `needs_revision`, never from a pending/ambiguous response. A provider-terminal failure ends the run; an ambiguity that cannot be conclusively reconciled requires a new explicitly authorized run rather than an invented retry transition.

Record each successful routed gate with `verification_recorded`. Coordinated
`accepted` re-hashes every required receipt and rejects a missing, changed,
failed, timed-out, output-limited, crossed-route, or different-artifact gate.
Otherwise record `needs_revision`, `blocked`, or `human_required`.

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
