# codex-chat protocol v1

## Pre-run browser and provider-readiness gate

The built-in Browser is primary. Ego Browser is the only alternative and is
eligible only when the primary is conclusively unavailable before source
selection, capsule creation, run creation, send reservation, upload, or send.
Once selected, one transport remains bound to the complete run.

Before built-in Browser tool discovery, the controller atomically claims the
app-wide transport circuit in `~/.codex/codex-chat/transport`. The claim records
the ChatGPT and `codex-code-mode-host` process generations and serializes the
bounded health probe across coordinators on the same desktop login. An
unexpired claim held by another coordinator denies a concurrent probe and also
denies Ego fallback, because a second browser writer could cross the active
coordinator.

An open circuit for the current browser-host generation denies the probe
without calling the already-closed tool transport during a fixed five-minute
cooldown and returns the exact `retryAfter`. The circuit becomes half-open
either after the browser-host process generation changes or, without claiming
a restart, for one serialized zero-I/O probe after the cooldown. A repeated
same-host failure restarts the cooldown. A successful no-I/O probe plus
supported read-only browser and provider checks closes it. A
non-transport provider blocker also closes it after browser health is proven,
while a repeated `Transport closed` result opens it. Claim completion is
token- and generation-bound, so a stale coordinator cannot close or trip
another coordinator's probe.

If primary tool discovery, supported runtime initialization, or a read-only
browser capability is unavailable without returning `Transport closed`, the
claim owner performs a neutral `release`. The gate records an `idle` state,
removes the claim, and records neither transport success nor failure. This
allows immediate fallback without leaving another coordinator blocked until
the two-minute claim expiry.

If the `node_repl` tool transport returns `Transport closed`, the controller
may rediscover the tool once and repeat one no-I/O probe. It does not call
`js_reset`, switch to another surface that depends on the same transport, or
loop retries. A repeated failure durably opens the claimed circuit before
fallback. A later controller reports the saved failure and exact retry time
without probing during the cooldown. After that instant, only the coordinator
that atomically claims the half-open slot may perform one new no-I/O probe.
Neither cooldown expiry nor a claim permits source preparation or send.

After a conclusive primary outage, an installed Ego skill and CLI may perform
one read-only readiness attempt in one opaque, randomly named task space. Before
that first Ego invocation, the coordinator acquires a digest-verified local
lease on the fixed `(chatgpt.com, ego-default, ego-browser)` bootstrap
descriptor. The lease binds immutable workspace, coordinator, work-unit,
agent, and attempt identities to a random capability whose raw token is never
persisted. A file lock serializes acquisition; a bounded expiry and monotonic
generation permit crash recovery, while the exact lease ID and capability stop
a stale owner from renewing or releasing its replacement.

An unexpired lease owned by another coordinator stops the fallback before any
task-space or source action. The owner renews the lease through readiness and
source preparation. It releases only after `send_reserved` has durably
acquired the ordinary logical-conversation lease, or after a stopped attempt
has no Ego operation in flight. Thus the handoff overlaps ownership instead of
leaving an unowned interval. The owner renews immediately before every bounded
Ego invocation. The generation records takeovers but cannot fence an invocation
already in flight when expiry occurs. This bootstrap lease is cooperative
single-host coordination, not distributed fencing across machines.

The readiness attempt
outputs only page, composer, authentication, and challenge status plus the
preflight, numeric task-space, and exact browser-target identifiers. It does
not output snapshots, draft text, or conversation content. The attempt
classifies the composer before source work. If ChatGPT restored an inherited
draft, Ego preserves that tab and gets one source-free attempt to create and
verify a distinct empty collaborator tab. A missing command, connection, task
space, page, composer, distinct target, or empty composer stops the branch
without retry, installation, or a third transport. Authentication and
verification transfer control to the user. Only explicit user confirmation
permits taking the same task space back for one read-only recheck.

Readiness uses field metadata to locate the composer and control metadata/text
to locate login and account controls. Unknown composer text participates only
in the bounded empty/nonempty/unsupported classification; it cannot influence
authentication, account, challenge, or composer-element detection.
The Ego browser adapter passes an exact, bounded observation schema to the
local `ego-readiness.mjs` decision core. The core rejects unknown fields and
draft bytes, validates stage and target identities, and is the sole source of
the ready, authentication-required, fresh-target, or stop decision. Browser
exceptions remain bounded adapter failures and never authorize a retry.

The successful selected transport opens or claims the intended external
collaborator conversation and verifies an authenticated composer from a fresh
read-only page observation. It records the provider namespace, unique logical
conversation identity, observed UI label, and any stable locator without
routing by title or model label. It does not type, paste, attach, upload, or
send during this gate. This zero-source-egress gate is outside the run ledger
because no collaboration run exists yet.

After run creation, an Ego selection is recorded as transport resource
evidence with its preflight, task-space, bound-target, and optional preserved
draft-target identifiers. Every compose, submit, observe, correction, and
cleanup command reselects the exact bound target and fails closed if it is
absent; the current or newest tab is never a substitute. Cleanup checks the
live target set through the same local decision module before any close or
task-space completion. Identity collisions, missing or duplicate targets, and
unexpected additional targets for whole-space cleanup produce a mutation-free
stop.
`send_confirmed.transportKind` is `ego-browser`, but the conversation identity
and canonical locator remain provider-level identities. The task-space ID is
not a conversation identity or locator, so all transports and coordinators
contend on the same provider-conversation leases.

A healthy primary with a logged-out, challenged, rate-limited, or otherwise
unready provider page does not authorize Ego fallback. User-owned
authentication or a provider-readiness blocker stops before source preparation
and is reported with no capsule prepared or transmitted and no external
collaborator claims.

Once an upload or send action might have run, this pre-run classification no
longer applies. No transport switch is allowed. A closed or failed transport
enters normal marker reconciliation: unknown delivery becomes
`send_ambiguous`, and no resend is authorized.

## Durable event ledger

`events.jsonl` is authoritative. `state.json` is a rebuildable cache. Each event has a monotonically increasing sequence, previous hash, typed payload, resulting snapshot, and SHA-256 over canonical JSON excluding its own hash. The ledger is written and fsynced before atomically replacing state.

Writers must provide both `expectedSequence` and `expectedState`. The reducer—not the caller—chooses the next state.

Typed events:

| Event | Allowed current state | Result |
| --- | --- | --- |
| `prepared` | uninitialized | `prepared` |
| `send_reserved` | `prepared`, `needs_revision` | `send_reserved`; reconcile the durable visible marker before any send |
| `send_confirmed` | `send_reserved` | `send_confirmed` |
| `send_ambiguous` | `send_reserved` | `response_pending_unknown` |
| `transport_disconnected`, `response_observed` | `send_confirmed`, `response_pending_unknown` | `response_pending_unknown` |
| `response_terminal` | confirmed/pending/human-required | `response_terminal` |
| `response_rejected` | confirmed/pending/human-required | `needs_revision`; bind immutable terminal bytes and the exact `RESULT_*` validation failure |
| `resource_observation`, `local_takeover` | non-terminal | unchanged |
| `suspended_both_limited` | confirmed/pending | `response_pending_unknown` |
| `review_started` | `response_terminal` | `reviewing` |
| `validation_started` | `reviewing` | `validating` |
| `verification_recorded` | `validating` | unchanged; bind one declared gate receipt |
| `needs_revision` | reviewing/validating | `needs_revision` |
| `accepted` | `validating` | `accepted`; coordinated runs require the complete matching gate set |
| `provider_terminal_failure`, `blocked` | allowed non-terminal states | `blocked` |
| `human_required` | allowed non-terminal states | `human_required` |

`send_reserved` never authorizes blind resend after recovery: reconcile its
durable outbound marker first, and use `send_ambiguous` when absence is not
conclusive. The reservation binds a unique outbound marker, an expected
terminal marker, turn ID, context digest, and conversation identity.
Idempotency records bind each key to the event type and canonical data digest;
conflicting reuse fails closed. The 128 most recent general records are kept in
the active snapshot, while outbound records remain permanent for the run.
`send_confirmed` and `response_pending_unknown` are observe-only. Only terminal
evidence bound to the active turn can enter review. Provider-terminal failure
ends the run, and an ambiguity that cannot be conclusively reconciled requires
a new explicitly authorized run.

An Ego writer persists the reservation before invoking the browser, then uses
separate bounded compose, submit, and observe commands. Composition proceeds
only when the normalized ChatGPT composer is empty or already exactly equals
the reserved task envelope. A strict executable decision core receives only
the bound task-space/target, digests, byte/count metadata, attachment identity,
and locator state; raw draft and response text are excluded. It decides the
only safe type/reuse branch, rechecks the exact ordinal/digest/bytes before one
click, and classifies accepted/absent/ambiguous delivery after the click. Its
narrow safe decision cannot replace the durable reservation, and it never
authorizes resend. Ego's `fillInput` is forbidden for this
contenteditable because it may append to a persisted draft. Any other non-empty
draft is left untouched and is never suggested for submission. Submission
rechecks the exact envelope, one marker, no matching submitted user turn, and
one enabled send control before one explicit click. Missing command output
enters read-only marker reconciliation; it never authorizes another click. An
immediate ChatGPT `/c/WEB:` path is provisional and cannot satisfy the
provider-locator binding. Read-only observation must obtain the stable
canonical conversation path or thread identifier before `send_confirmed`;
otherwise the controller preserves the evidence without inventing a locator.

New hardened runs set `outboundBindingVersion: 2` in `prepared` and bind the
exact task envelope separately from the context artifact. Their first
`send_reserved` repeats `contextSha256`, `taskEnvelopeSha256`, provider
namespace, and the optional typed transport-manifest digest. The legacy
`payloadSha256` remains the context digest for result/import compatibility; it
is not described as the full outbound prompt. A correction turn may use a new
task-envelope digest while retaining the immutable context binding.

Before creating a new hardened run, `transport-plan` re-reads and
digest-checks the portable context and exact task envelope, scans both with the
generated `CODEX_CHAT_TRANSPORT_MANIFEST_V1`, and chooses one deterministic
strategy. A context no larger than 24,576 bytes is embedded in one canonical
composer envelope only when the complete envelope remains within 49,152
bytes. Its task/context boundaries carry an identifier derived from both exact
input digests, so matching words inside source files cannot impersonate the
wrapper. Larger context requires upload capability observed as available and
is bound as attachment ordinal zero. Unknown or unavailable upload stops, as
does a composer task envelope over 32,768 bytes. The fixed thresholds are
project protocol limits, not provider capacity claims.

The manifest binds the selected transport, both input digests and byte counts,
the exact composer text/digest, optional attachment digest/ordinal, and the
decision thresholds. `prepared` and the first `send_reserved` bind its digest
as `transportManifestSha256`. The plan is deterministic and create-only but
always reports `actionAuthorized: false`, `resendAuthorized: false`, and
`modelVisible: "unknown"`. Only a later durable reservation and the bound
transport adapter may perform the selected action once. Changed plan bytes,
capability, strategy, composer text, context artifact, or attachment ordinal
stop instead of triggering an improvised fallback.

Coordinated runs add immutable `workspaceId`, `coordinatorId`, `workUnitId`,
and `agentId` routing. A hardened reservation takes a state-directory-wide
lease on `(providerNamespace, conversationIdentity)`. Confirmation also binds
the reserved marker and conversation, transport kind, canonical provider
locator, observation time, evidence class, and a provider-message fingerprint
when observable, and takes a second lease on that locator. Different runs or
coordinators cannot own either local lease concurrently. Terminal runs release
their leases; a new claimant may also fence out an owner whose durable run is
already terminal. These are single-host file leases, not distributed fencing.
Multi-host participants use the separate authoritative epoch, run-head,
conversation-claim, and mailbox service described in
[distributed-coordination-v1.md](distributed-coordination-v1.md). The two
ledgers have different responsibilities: distributed CAS coordinates hosts;
the local run ledger preserves detailed browser workflow and acceptance
evidence. See [coordination-v2.md](coordination-v2.md).

Every run segment has a fixed 1,024-event limit. The last 32 slots accept only
terminal capture, review, declared verification, acceptance, or blocking, so
observation noise cannot strand a run without completion capacity. A
continuation `prepared` event may bind `parent.runId`,
`parent.eventSequence`, and `parent.eventHash`; the writer verifies that exact
parent head before creating the new segment. The old hash chain is never
rewritten.

## Typed context sidecar

`manifest` creates a scanned `COLLAB_CONTEXT_MANIFEST_V2` sidecar from a
`CODEX_CHAT_MANIFEST_PLAN_V2`. It records exact byte counts and digests for
code, text, images, PDFs, documents, spreadsheets, and data. A derived
representation references its source digest and records tool, version,
parameters, coverage, locator, fidelity, and truncation.

Every new manifest starts with delivery status `staged` and model visibility
`unknown`. The sidecar is provenance, not proof that a provider accepted an
attachment or that the model could see it.

`delivery-receipt` creates a separate scanned
`COLLAB_DELIVERY_RECEIPT_V2` from a
`CODEX_CHAT_DELIVERY_RECEIPT_PLAN_V2`. It requires an existing coordinated run
with a confirmed outbound and binds one manifest representation and
attachment ordinal to the exact current ledger sequence/hash, context, full
route, conversation, turn, confirmed transport locator, observation time,
provider evidence, and raw evidence digest. The manifest representation digest
and declared bytes must match. `exact-payload` evidence must itself equal the
representation bytes; metadata and UI evidence make no such claim.

The manifest, plan, raw evidence, and canonical receipt are secret-scanned
together. Receipt paths are state-managed and create-only. The immutable slot
identity is derived from route, run, conversation, turn, and attachment
ordinal. Writers serialize on the slot and run; the run head is compared again
under the run lock immediately before creation. An identical replay is
idempotent, while a different claim for the slot fails with
`DELIVERY_SLOT_CONFLICT`. Only a valid `<slotId>.slot.json` makes its
content-addressed receipt authoritative. A receipt file left before a crash
without its slot is non-authoritative; the same replay can finish the slot.

Delivery and terminal evidence use the same immutable-evidence store. The
store serializes each slot, acquires any required run-head lock, rechecks the
authoritative run under that lock, validates private directory identities,
opens existing artifacts without following symbolic links, verifies exact
bytes on replay, publishes artifacts before the authoritative slot, and
revalidates every artifact when the slot already exists. Different slots may
share identical content-addressed objects without crossing their authority.

Allowed transport states are `accepted` and `rejected`, but both retain
`modelVisible: "unknown"`. Provider acceptance proves neither backend model
identity nor model visibility. The command does not upload, send, mutate the
manifest or ledger, accept the work, or authorize a retry.

`parent.contextSha256`, `parent.turnId`, and `checkpointNamespace` link
continuation context without rewriting earlier artifacts. The CLI does not
control attachment upload; a bound browser adapter may perform the one planned
upload and must record transport evidence afterward. Delta reconstruction is
not implemented. Model-visibility evidence is also deferred to a future
append-only artifact.

## External result

The collaborator returns one bounded JSON object conforming to `COLLAB_RESULT_V1`, containing:

- protocol version, run ID, turn ID, and exact context SHA-256;
- `complete: true`, `artifactKind`, a concise summary, and claims separated from evidence;
- for `artifactKind: "advisory"`, no patch or preimages;
- for `artifactKind: "patch"`, one unified diff plus its SHA-256 and exactly one target preimage path and SHA-256.

The response places the exact JSON bytes between `CODEX_CHAT_RESULT_BEGIN` and
`CODEX_CHAT_RESULT_END` boundary lines and ends with the expected terminal
marker. Save the bytes between the boundary lines unchanged with one final LF.
For a hardened run, `terminal-capture` reads both the full response and saved
result, verifies the exact boundary extraction, result schema, run/turn/context
binding, expected terminal marker, route, provider fingerprint, and task
binding, then secret-scans and publishes create-once content-addressed objects,
a receipt, and one authoritative turn slot. It returns the exact
`response_terminal` event data.

If the boundary bytes are intact but the result envelope is invalid, rerun
capture with `--result-mode rejected`. The helper requires an exact `RESULT_*`
failure, publishes the same immutable evidence with that rejection bound into
the receipt, and returns `response_rejected` data. That event enters
`needs_revision` only: it cannot start review, import, verification, or
acceptance. A correction uses a fresh reserved turn and never edits or
reconstructs the rejected envelope.

Hardened `response_terminal` refuses hash claims without that receipt and
re-reads the receipt and both stored objects. Review start, import, and final
acceptance revalidate them again, so later evidence mutation fails closed.
Legacy runs remain readable and retain their earlier hash-only terminal
contract.

The expected run ID, reserved turn ID, active outbound context digest, terminal result-envelope digest, and canonical source root are mandatory import bindings. Advisory results are quarantined, scanned, and receipted without scratch mutation. Patch application additionally requires the canonical scratch identity. Application receipts include the source/scratch identities and use write-ahead `prepared` then `applied` durability. Patch application is serialized by canonical scratch identity and target path. Immediately before replacement, the importer re-opens the target without following symlinks and compares its inode and preimage digest.

The supported diff subset changes one existing regular UTF-8/LF file with exact zero-fuzz hunks. There is no creation, deletion, rename, mode change, binary patch, timestamp, `/dev/null`, multi-file diff, or no-newline directive.

Verification plans may carry routed bindings for run, turn, context,
application key, postimage, and gate. The verifier writes a terminal receipt
for success, failure, timeout, signal, and output-limit outcomes after a process
starts. `verification_recorded` accepts only successful matching receipts;
`accepted` re-hashes every required receipt and requires all gates to bind the
same application/postimage.

## Resource observations

Track controller, collaborator, transport, external-model UI, agentic pool,
upload, and API budget separately. Every update includes `status`, `source`,
`observedAt`, and optional `expiresAt`. API budget stays
`disabled_by_policy`. External model backend identity stays `unverified`.
Callers may set `coalesce: true` for noncritical resource observations. An
equivalent observation within five seconds returns `coalesced: true` without
growing the ledger; the first observation and semantic/expiry changes remain
durable.

`recovery-plan` is a deterministic read-only transport-adapter contract. It
returns the exact run head, route, marker, terminal marker, conversation,
confirmed locator, held local leases, allowed observation events, and forbidden
transport actions. It always sets `sendAllowed: false` and
`resendAllowed: false`; conclusive marker absence is returned to the accountable
controller rather than authorizing an adapter to send.

## CLI result

Every command emits one JSON line:

```json
{
  "schema": "codex-chat/cli/v1",
  "ok": true,
  "protocolVersion": 1,
  "stateVersion": 1,
  "command": "status",
  "data": {}
}
```

Failures set `ok: false`, emit a stable symbolic error code, and exit nonzero.
