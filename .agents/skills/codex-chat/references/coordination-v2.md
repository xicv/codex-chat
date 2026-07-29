# Multi-agent and multi-coordinator coordination

The isolation key is:

```text
(workspaceId, coordinatorId, runId, workUnitId, agentId,
 conversationIdentity, turnId, attemptId, artifactId)
```

Never route by a conversation title, visible model label, file name, or “latest”
message. Those values are descriptive, not identities.

## Current coordinated-run contract

A coordinated run may declare `routing` and `requiredGates` in `prepared`.
`send_reserved` adds exactly one `agentId`. `send_confirmed` must repeat the
whole route, outbound marker, conversation identity, transport, locator,
observation time, and provider-message fingerprint when one is observable.
`response_terminal` must repeat the route and describe a terminal,
non-truncated capture. A mismatch is rejected rather than attached to the
nearest active run.

Every writer still supplies expected event sequence and phase. The hash-chained
ledger is one compare-and-swap stream per run. Outbound idempotency keys and
visible markers are permanent for that run.

Attachment delivery uses a narrower immutable slot:

```text
(workspaceId, coordinatorId, runId, workUnitId, agentId,
 conversationIdentity, turnId, attachmentOrdinal)
```

One receipt observes one manifest representation in that slot. The helper
serializes on both the slot and run, then compares the planned ledger
sequence/hash under the run lock. An identical replay is idempotent; different
evidence cannot replace the slot. Thus agents and coordinators operating on
different route tuples do not share delivery slots, while crossed identities
fail closed instead of attaching to whichever conversation is active.

`verification_recorded` re-reads and hashes an immutable receipt. All declared
gates must bind the same run, turn, context, route, application key, and
postimage. `accepted` re-hashes those receipts before it can become terminal.

This is an opt-in v1-compatible path. Legacy v1 runs remain readable but do not
gain evidence that was never recorded.

## Direct messages and broadcasts

Mutation commands are direct:

```text
mailbox = (workspaceId, coordinatorId, runId, workUnitId, agentId)
```

The response must contain the direct message ID, correlation ID, causal parent
ID, route tuple, payload digest, and expected stream head. A response with a
different tuple or causal parent is a `crossed_response`; it is quarantined and
cannot advance state.

Broadcasts are evidence-only by default:

```text
topic = (workspaceId, runId, workUnitId, type, source)
```

Freeze the recipient list at publication and record one receipt per recipient.
A broadcast never grants write authority and never counts as consensus merely
because multiple agents repeat the same claim.

## Parallel work

Read-only agents may run concurrently when every input is an immutable digest.
They write new evidence artifacts in distinct namespaces.

Writers require either:

- disjoint target paths;
- isolated worktrees with disjoint ownership; or
- serialization behind one target lease.

The importer currently serializes by canonical scratch identity plus target
path, holds the lock through the applied receipt, and re-opens the target with
no-follow semantics for a final inode/hash comparison. Overlapping compliant
writers therefore produce one winner; the loser sees a stale preimage.

Merging is its own single-writer work unit with explicit parent artifacts. Do
not let several coordinators merge into one mutable checkout independently.

## Coordinator failover and future fencing

A distributed v2 coordinator needs an epoch lease:

```text
(workspaceId, runId, coordinatorEpoch, owner, expiry, fencingToken)
```

Each successful takeover increments the fencing token. Every mutation,
receipt, and checkpoint must include the current token; storage rejects stale
tokens even if the old coordinator resumes after a pause. Expiry alone is not
enough: the new coordinator first reconciles the run ledger and any pending
external send. Confirmed or ambiguous sends remain observe-only after failover.

The current local lock safely reclaims a proven-dead PID but does not yet
provide distributed fencing or PID-reuse diagnostics. Do not represent it as a
multi-host lease.

## Backpressure and cancellation

Give each mailbox a fixed maximum in-flight count and byte budget. Reject or
queue new work before those limits are exceeded. Cancellation is a durable
event addressed to one route and causal message. It is cooperative: it stops
new side effects but cannot erase a send, file replacement, or receipt that
already became durable.

Checkpoint namespaces should include workspace, run, and work unit. Continuing
a long run starts a new history segment whose parent is the previous terminal
event/context digest; it never rewrites the old stream.
