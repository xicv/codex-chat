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
| `needs_revision` | reviewing/validating | `needs_revision` |
| `accepted` | `validating` | `accepted` |
| `provider_terminal_failure`, `blocked` | allowed non-terminal states | `blocked` |
| `human_required` | allowed non-terminal states | `human_required` |

`send_reserved` never authorizes blind resend after recovery: reconcile its durable outbound marker first, and use `send_ambiguous` when absence is not conclusive. The reservation binds a unique outbound marker, an expected terminal marker, turn ID, payload digest, and conversation identity. Idempotency records bind each key to the event type and canonical data digest; conflicting reuse fails closed. `send_confirmed` and `response_pending_unknown` are observe-only. Only terminal evidence bound to the active turn can enter review. Provider-terminal failure ends the run, and an ambiguity that cannot be conclusively reconciled requires a new explicitly authorized run.

## External result

The collaborator returns one bounded JSON object conforming to `COLLAB_RESULT_V1`, containing:

- protocol version, run ID, turn ID, and exact context SHA-256;
- `complete: true`, `artifactKind`, a concise summary, and claims separated from evidence;
- for `artifactKind: "advisory"`, no patch or preimages;
- for `artifactKind: "patch"`, one unified diff plus its SHA-256 and exactly one target preimage path and SHA-256.

The response places the exact JSON bytes between `CODEX_CHAT_RESULT_BEGIN` and `CODEX_CHAT_RESULT_END` boundary lines and ends with the expected terminal marker. Save the bytes between the boundary lines unchanged with one final LF. `response_terminal` binds both the full rendered response SHA-256 and this exact result-envelope SHA-256. `import` hashes the raw saved bytes before parsing and rejects a digest mismatch.

The expected run ID, reserved turn ID, active outbound context digest, terminal result-envelope digest, and canonical source root are mandatory import bindings. Advisory results are quarantined, scanned, and receipted without scratch mutation. Patch application additionally requires the canonical scratch identity. Application receipts include the source/scratch identities and use write-ahead `prepared` then `applied` durability.

The supported diff subset changes one existing regular UTF-8/LF file with exact zero-fuzz hunks. There is no creation, deletion, rename, mode change, binary patch, timestamp, `/dev/null`, multi-file diff, or no-newline directive.

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
