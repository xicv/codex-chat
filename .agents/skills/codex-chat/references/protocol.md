# codex-chat protocol v1

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
| `resource_observation`, `local_takeover` | non-terminal | unchanged |
| `suspended_both_limited` | confirmed/pending | `response_pending_unknown` |
| `review_started` | `response_terminal` | `reviewing` |
| `validation_started` | `reviewing` | `validating` |
| `verification_recorded` | `validating` | unchanged; bind one declared gate receipt |
| `needs_revision` | reviewing/validating | `needs_revision` |
| `accepted` | `validating` | `accepted`; coordinated runs require the complete matching gate set |
| `provider_terminal_failure`, `blocked` | allowed non-terminal states | `blocked` |
| `human_required` | allowed non-terminal states | `human_required` |

`send_reserved` never authorizes blind resend after recovery: reconcile its durable outbound marker first, and use `send_ambiguous` when absence is not conclusive. The reservation binds a unique outbound marker, an expected terminal marker, turn ID, payload digest, and conversation identity. Idempotency records bind each key to the event type and canonical data digest; conflicting reuse fails closed. `send_confirmed` and `response_pending_unknown` are observe-only. Only terminal evidence bound to the active turn can enter review. Provider-terminal failure ends the run, and an ambiguity that cannot be conclusively reconciled requires a new explicitly authorized run.

Coordinated runs add immutable `workspaceId`, `coordinatorId`, `workUnitId`,
and `agentId` routing. Send confirmation also binds the reserved marker and
conversation, transport kind, locator, observation time, evidence class, and a
provider-message fingerprint when observable. Terminal promotion requires the
same route plus a terminal, non-truncated capture. See
[coordination-v2.md](coordination-v2.md).

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

Allowed transport states are `accepted` and `rejected`, but both retain
`modelVisible: "unknown"`. Provider acceptance proves neither backend model
identity nor model visibility. The command does not upload, send, mutate the
manifest or ledger, accept the work, or authorize a retry.

`parent.contextSha256`, `parent.turnId`, and `checkpointNamespace` link
continuation context without rewriting earlier artifacts. The sidecar does not
yet implement delta reconstruction or attachment upload. Model-visibility
evidence is also deferred to a future append-only artifact.

## External result

The collaborator returns one bounded JSON object conforming to `COLLAB_RESULT_V1`, containing:

- protocol version, run ID, turn ID, and exact context SHA-256;
- `complete: true`, `artifactKind`, a concise summary, and claims separated from evidence;
- for `artifactKind: "advisory"`, no patch or preimages;
- for `artifactKind: "patch"`, one unified diff plus its SHA-256 and exactly one target preimage path and SHA-256.

The response places the exact JSON bytes between `CODEX_CHAT_RESULT_BEGIN` and `CODEX_CHAT_RESULT_END` boundary lines and ends with the expected terminal marker. Save the bytes between the boundary lines unchanged with one final LF. `response_terminal` binds both the full rendered response SHA-256 and this exact result-envelope SHA-256. `import` hashes the raw saved bytes before parsing and rejects a digest mismatch.

The expected run ID, reserved turn ID, active outbound context digest, terminal result-envelope digest, and canonical source root are mandatory import bindings. Advisory results are quarantined, scanned, and receipted without scratch mutation. Patch application additionally requires the canonical scratch identity. Application receipts include the source/scratch identities and use write-ahead `prepared` then `applied` durability. Patch application is serialized by canonical scratch identity and target path. Immediately before replacement, the importer re-opens the target without following symlinks and compares its inode and preimage digest.

The supported diff subset changes one existing regular UTF-8/LF file with exact zero-fuzz hunks. There is no creation, deletion, rename, mode change, binary patch, timestamp, `/dev/null`, multi-file diff, or no-newline directive.

Verification plans may carry routed bindings for run, turn, context,
application key, postimage, and gate. The verifier writes a terminal receipt
for success, failure, timeout, signal, and output-limit outcomes after a process
starts. `verification_recorded` accepts only successful matching receipts;
`accepted` re-hashes every required receipt and requires all gates to bind the
same application/postimage.

## Resource observations

Track controller, collaborator, transport, external-model UI, agentic pool, upload, and API budget separately. Every update includes `status`, `source`, `observedAt`, and optional `expiresAt`. API budget stays `disabled_by_policy`. External model backend identity stays `unverified`.

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
