# Distributed coordination control plane v1

The distributed control plane is an opt-in authority service for several
coordinator or agent processes that cannot share the single-host file locks.
All participants in one coordination domain connect to one authoritative
`control-serve` process. That process serializes mutations, assigns coordinator
epochs, fences stale owners, and persists partitioned mailbox state.

This is a single-authority design, not a consensus system. It supports clients
on several hosts, but it does not make the authority process highly available.
If the authority is unavailable, clients fail closed until it recovers from
its local durable state.

## Deployment boundary

Use a local filesystem for the authority state directory. Do not start two
authority processes against the same directory and do not put it on a network
filesystem whose create, append, rename, lock, or fsync semantics are
uncertain.

Populate a deployment-scoped bearer token (32 or more random base64/base64url
ASCII bytes) in the environment through the host's secret manager; do not put
its value in shell history:

```bash
# CODEX_CHAT_CONTROL_TOKEN is already present and contains 32+ random bytes.
```

Loopback development:

```bash
node <skill>/scripts/codex-chat.mjs control-serve \
  --state-dir /var/lib/codex-chat/control \
  --host 127.0.0.1 \
  --port 9443
```

Multi-host listeners require TLS:

```bash
node <skill>/scripts/codex-chat.mjs control-serve \
  --state-dir /var/lib/codex-chat/control \
  --host 10.0.0.8 \
  --port 9443 \
  --tls-key /secure/control.key \
  --tls-cert /secure/control.crt \
  --tls-ca /secure/client-ca.crt \
  --require-client-cert true
```

A client sends one request document:

```bash
export CODEX_CHAT_CONTROL_ENDPOINT='https://10.0.0.8:9443'

node <skill>/scripts/codex-chat.mjs control \
  --request /private/tmp/coordination-request.json \
  --ca /secure/control-ca.crt \
  --client-key /secure/coordinator.key \
  --client-cert /secure/coordinator.crt
```

The token is accepted only through `CODEX_CHAT_CONTROL_TOKEN`; it is not a CLI
argument and is never printed in the readiness or response envelope. Client
certificate and key options must be paired. Plain HTTP clients and listeners
are restricted to literal `127.0.0.1` or `::1`; a DNS name such as
`localhost` requires TLS so resolution cannot redirect the bearer token.

The bearer token identifies one trusted coordination domain, not a tenant or
individual actor. Any holder can address any workspace and propose any
`ownerId`. Use a different daemon, state directory, and token for principals
that must not trust one another. Mutual TLS protects transport identity but v1
does not map certificate subjects to workspace or operation authorization.

## Envelope

Every request conforms to
[`distributed-coordination-request-v1.schema.json`](schemas/distributed-coordination-request-v1.schema.json):

```json
{
  "operation": "lease.acquire",
  "idempotencyKey": "workspace-a:run-a:lease:1",
  "data": {
    "workspaceId": "workspace-a",
    "runId": "run-a",
    "ownerId": "coordinator-a",
    "ttlMs": 30000
  }
}
```

Mutations require a permanent idempotency key. `run.read`, `mail.peek`,
`mail.inspect`, and `mail.list` are read-only and forbid one. Successful
replies contain the
authoritative mutation sequence, whether the result was an idempotent replay,
and the result. Failures contain a stable symbolic code. See
[`distributed-coordination-response-v1.schema.json`](schemas/distributed-coordination-response-v1.schema.json).

The HTTP route is exactly `POST /v1/execute` with `application/json`.
Requests are bounded, strict UTF-8 JSON. The service bounds headers, request
time, response size, and per-address request rate.

## Coordinator epoch and fencing

`lease.acquire` requires `workspaceId`, `runId`, `ownerId`, and `ttlMs`.
Exactly one unexpired lease may exist for a workspace/run pair. Initial
acquisition and every post-expiry or post-release takeover increment both
`coordinatorEpoch` and `fencingToken`.

All fenced mutations repeat:

```text
(workspaceId, runId, ownerId, leaseId, fencingToken)
```

`ownerId` identifies one coordinator process incarnation. The mailbox
`coordinatorId` is the immutable logical route identity and can remain stable
when a new process incarnation takes over the run.

The service checks the exact current lease and its server-clock expiry. A
paused old coordinator receives `STALE_FENCE` after takeover even if it later
resumes. `lease.renew` extends only the current lease. `lease.release`
relinquishes it explicitly.

Lease expiry is necessary but not sufficient to resend external work. After a
takeover, the coordinator must reconcile the distributed run head, mailbox,
local run evidence, and any pending provider send. Confirmed or ambiguous
sends remain observe-only.

## Authoritative distributed run head

`run.append` carries an event ID/type, payload SHA-256, terminal flag, and the
exact `expectedSequence`/`expectedHash`. The service compares and appends one
new hash-chained head or returns `DISTRIBUTED_RUN_HEAD_CONFLICT`. Event IDs
cannot be reused and terminal streams cannot be reopened.

`run.read` returns the current distributed head. This distributed stream is a
coordination/CAS seam; it does not replace the richer local browser-workflow
ledger, terminal receipts, or independent verification evidence. Bind local
artifacts to the distributed head when they cross hosts.

## Provider conversation claims

`conversation.claim` and `conversation.release` are fenced mutations. A
descriptor contains:

```json
{
  "providerNamespace": "chatgpt",
  "type": "thread-id",
  "value": "provider-stable-value"
}
```

One non-terminal distributed run owns a descriptor at a time. A terminal owner
or explicit release permits a new generation. A coordinator takeover within
the same run refreshes the claim to the new fence.

## Durable partitioned mailboxes

Every mailbox is addressed by the complete immutable route:

```text
(workspaceId, coordinatorId, runId, workUnitId, agentId)
```

`mail.enqueue` is fenced and binds:

- globally unique `messageId`;
- `correlationId` and optional `causalParentId`;
- `senderId`;
- JSON payload, its canonical SHA-256, and byte count;
- the exact current non-terminal distributed run head.

Canonical JSON digests sort object keys lexicographically at every depth,
preserve array order, and use JSON primitive serialization without whitespace.
Strings are not Unicode-normalized. Node clients can import
`canonicalCoordinationSha256` from
`scripts/lib/distributed-coordination.mjs`; other clients must reproduce this
algorithm exactly. An ordinary insertion-order `JSON.stringify` digest is
insufficient for multi-key objects.

Each mailbox has fixed queued-message, queued-byte, in-flight, retained-message,
and per-message limits. Global retained-payload capacity bounds the complete
authority state. Capacity failures are explicit backpressure; clients wait,
acknowledge/cancel and prune finalized messages, or split independent work.

Poll with read-only `mail.peek`, which validates the active fence and complete
route but creates no journal event or idempotency record. It returns either
`candidate: null` or the next claimable `messageId` and its current
`deliveryAttempt`; it never returns the payload or a claim token. Even an
expired in-flight message may be reported because the next mutation can
redeliver it. Repeated empty peeks therefore consume no durable mutation
capacity.

`mail.claim` is fenced and names a consumer and visibility timeout. It returns
one message plus a random claim token, or `message: null`. To close the race
between peek and claim, pass both `expectedMessageId` and
`expectedDeliveryAttempt`; the serialized authority returns
`MAILBOX_AVAILABILITY_STALE` unless that exact candidate is still next.
Omitting both fields preserves the v1-compatible unbound claim. An expired
claim is returned to the queue and increments its delivery attempt on
redelivery. Only work created by the current fencing token is claimable. Do not
use empty `mail.claim` calls as a polling primitive because every claim
mutation permanently consumes journal and idempotency capacity.

`mail.ack` requires the same current coordinator fence, consumer, unexpired
claim token, route, and message ID. This provides at-least-once delivery with
an explicit acknowledgement boundary; handler side effects must still be
idempotent.

`mail.cancel` is a durable, fenced, causal event. A takeover coordinator may
cancel queued or in-flight work from the old fence. Cancellation is
cooperative: it prevents future delivery or acknowledgement but cannot undo an
external send or side effect that already completed.

`mail.prune` accepts a bounded list of acknowledged or cancelled message IDs.
It deletes their payloads while retaining immutable ID/digest/status
tombstones, so pruned IDs cannot be reused. `mail.peek`, `mail.inspect`, and
`mail.list` are read-only inspection operations.

The transport token is deployment-wide authority. In v1 an agent process that
directly claims or acknowledges also receives the current fence fields and is
therefore inside that trusted domain. Do not expose the endpoint or token to an
untrusted external model or browser page.

## Durability and recovery

`events.jsonl` is the authoritative write-ahead journal. Every successful
mutation is canonicalized, chained to the prior event hash, appended, and
fsynced before the in-memory state becomes visible. Generated lease and claim
IDs are recorded so replay is deterministic.

`state.json` is an atomically replaced, fsynced checkpoint cache. Startup:

1. acquires the process-lifetime ownership lock;
2. opens state files without following symbolic links;
3. validates regular-file type, UTF-8, byte bounds, event sequence, hashes,
   limit digest, logical time, and replayed result digests;
4. preserves and truncates only an incomplete final journal record;
5. deterministically rebuilds state and repairs a missing, stale, or corrupt
   checkpoint.

An intact checkpoint never overrides missing journal history. Altered history,
a snapshot ahead of the journal, a different limit set, or an oversized state
file fails closed.

Shutdown stops accepting new work, drains already accepted operations,
checkpoints the last sequence, and releases ownership even if checkpointing
fails. The journal remains authoritative after such a failure.

## Capacity and operations

The limits in [limits.md](limits.md) are protocol ceilings. API-level limit
overrides may only tighten them. The service stops before journal,
idempotency-result, tombstone, retained-payload, or run-event capacity would be
exceeded.

Capacity is intentionally finite so corrupt or hostile input cannot cause
unbounded restart memory. Once a coordination segment approaches a lifetime
limit, stop admitting work, make every run terminal, archive the complete
state directory, and start a new empty segment. Do not rotate an active segment
because its epochs, idempotency history, conversation generations, and message
tombstones are safety state.

## Concurrency model and remaining exclusions

The authority has one global serialized mutation queue. That makes races
deterministic and keeps the persistence adapter deep, but it is also the
throughput ceiling. Separate daemons may shard genuinely independent trust and
failure domains; the same run, mailbox, or provider conversation must never
span shards.

V1 deliberately excludes:

- replicated consensus, automatic leader election, and quorum fencing;
- automatic failover of the authority host;
- network-filesystem or multi-writer storage;
- per-certificate or per-operation authorization;
- streaming/long-poll delivery and dead-letter queues;
- automatic active-segment compaction.

These exclusions must remain visible in operational claims. Multi-host clients
are supported; a highly available multi-authority cluster is not.
