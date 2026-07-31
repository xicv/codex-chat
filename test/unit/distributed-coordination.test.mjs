import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import {
  canonicalCoordinationSha256,
  openCoordinationControlPlane,
} from "../../.agents/skills/codex-chat/scripts/lib/distributed-coordination.mjs";
import {
  executeRemoteCoordination,
  startCoordinationHttpServer,
} from "../../.agents/skills/codex-chat/scripts/lib/distributed-coordination-http.mjs";
import { runCli, tempDir, writeFixture } from "../helpers.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("canonical coordination digests are stable across object insertion order", () => {
  const expected = sha256('{"a":1,"b":{"c":2,"d":3}}');
  assert.equal(
    canonicalCoordinationSha256({ b: { d: 3, c: 2 }, a: 1 }),
    expected,
  );
  assert.equal(
    canonicalCoordinationSha256({ a: 1, b: { c: 2, d: 3 } }),
    expected,
  );
});

function deterministicIds(...values) {
  const ids = [...values];
  return () => {
    assert.notEqual(ids.length, 0, "test exhausted deterministic IDs");
    return ids.shift();
  };
}

function runExecutable(executable, args) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

test("coordinator epoch leases survive restart and fence stale owners", async () => {
  const stateDir = await tempDir("codex-chat-control-plane-");
  let nowMs = Date.parse("2026-07-30T00:00:00.000Z");
  let plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => nowMs,
    randomId: deterministicIds("lease-first"),
  });

  const firstRequest = {
    operation: "lease.acquire",
    idempotencyKey: "acquire-first",
    data: {
      workspaceId: "workspace-a",
      runId: "run-a",
      ownerId: "coordinator-instance-a",
      ttlMs: 10_000,
    },
  };
  const first = await plane.execute(firstRequest);
  assert.equal(first.idempotent, false);
  assert.deepEqual(first.result, {
    workspaceId: "workspace-a",
    runId: "run-a",
    ownerId: "coordinator-instance-a",
    leaseId: "lease-first",
    coordinatorEpoch: 1,
    fencingToken: 1,
    acquiredAt: "2026-07-30T00:00:00.000Z",
    expiresAt: "2026-07-30T00:00:10.000Z",
  });
  const replay = await plane.execute(firstRequest);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.result, first.result);
  await plane.close();

  nowMs += 10_001;
  plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => nowMs,
    randomId: deterministicIds("lease-second"),
  });
  const second = await plane.execute({
    operation: "lease.acquire",
    idempotencyKey: "acquire-second",
    data: {
      workspaceId: "workspace-a",
      runId: "run-a",
      ownerId: "coordinator-instance-b",
      ttlMs: 10_000,
    },
  });
  assert.equal(second.result.coordinatorEpoch, 2);
  assert.equal(second.result.fencingToken, 2);
  assert.equal(second.result.leaseId, "lease-second");

  await assert.rejects(
    plane.execute({
      operation: "lease.renew",
      idempotencyKey: "renew-stale-first",
      data: {
        workspaceId: "workspace-a",
        runId: "run-a",
        ownerId: "coordinator-instance-a",
        leaseId: "lease-first",
        fencingToken: 1,
        ttlMs: 10_000,
      },
    }),
    (error) => error.code === "STALE_FENCE",
  );
  await plane.close();
});

test("control-plane close drains already accepted mutations before releasing its lock", async () => {
  const stateDir = await tempDir("codex-chat-control-close-drain-");
  const request = {
    operation: "lease.acquire",
    idempotencyKey: "close-drain-acquire",
    data: {
      workspaceId: "workspace-close-drain",
      runId: "run-close-drain",
      ownerId: "coordinator-close-drain",
      ttlMs: 60_000,
    },
  };
  let plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => Date.parse("2026-07-30T00:30:00.000Z"),
    randomId: deterministicIds("lease-close-drain"),
  });
  const accepted = plane.execute(request);
  const closing = plane.close();
  assert.equal((await accepted).result.leaseId, "lease-close-drain");
  await closing;

  plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => Date.parse("2026-07-30T00:30:01.000Z"),
  });
  const replayed = await plane.execute(request);
  assert.equal(replayed.idempotent, true);
  assert.equal(replayed.result.leaseId, "lease-close-drain");
  await plane.close();
});

test("distributed run mutations require the active fence and exact stream head", async () => {
  const stateDir = await tempDir("codex-chat-control-run-");
  let nowMs = Date.parse("2026-07-30T01:00:00.000Z");
  const plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => nowMs,
    randomId: deterministicIds("lease-run-first", "lease-run-second"),
  });
  const first = (await plane.execute({
    operation: "lease.acquire",
    idempotencyKey: "run-acquire-first",
    data: {
      workspaceId: "workspace-run",
      runId: "run-stream",
      ownerId: "coordinator-run-first",
      ttlMs: 1_000,
    },
  })).result;
  const appended = await plane.execute({
    operation: "run.append",
    idempotencyKey: "run-event-first",
    data: {
      ...first,
      eventId: "event-first",
      eventType: "prepared",
      payloadSha256: "a".repeat(64),
      expectedSequence: 0,
      expectedHash: null,
      terminal: false,
    },
  });
  assert.equal(appended.result.eventSequence, 1);
  assert.match(appended.result.eventHash, /^[a-f0-9]{64}$/);
  assert.equal(appended.result.terminal, false);

  await assert.rejects(
    plane.execute({
      operation: "run.append",
      idempotencyKey: "run-event-crossed-head",
      data: {
        ...first,
        eventId: "event-crossed",
        eventType: "response-observed",
        payloadSha256: "b".repeat(64),
        expectedSequence: 0,
        expectedHash: null,
        terminal: false,
      },
    }),
    (error) => error.code === "DISTRIBUTED_RUN_HEAD_CONFLICT",
  );

  nowMs += 1_001;
  const second = (await plane.execute({
    operation: "lease.acquire",
    idempotencyKey: "run-acquire-second",
    data: {
      workspaceId: "workspace-run",
      runId: "run-stream",
      ownerId: "coordinator-run-second",
      ttlMs: 10_000,
    },
  })).result;
  await assert.rejects(
    plane.execute({
      operation: "run.append",
      idempotencyKey: "run-event-stale-fence",
      data: {
        ...first,
        eventId: "event-stale",
        eventType: "response-observed",
        payloadSha256: "c".repeat(64),
        expectedSequence: appended.result.eventSequence,
        expectedHash: appended.result.eventHash,
        terminal: false,
      },
    }),
    (error) => error.code === "STALE_FENCE",
  );

  const terminal = await plane.execute({
    operation: "run.append",
    idempotencyKey: "run-event-terminal",
    data: {
      ...second,
      eventId: "event-terminal",
      eventType: "accepted",
      payloadSha256: "d".repeat(64),
      expectedSequence: appended.result.eventSequence,
      expectedHash: appended.result.eventHash,
      terminal: true,
    },
  });
  assert.equal(terminal.result.eventSequence, 2);
  assert.equal(terminal.result.terminal, true);
  await assert.rejects(
    plane.execute({
      operation: "run.append",
      idempotencyKey: "run-event-after-terminal",
      data: {
        ...second,
        eventId: "event-too-late",
        eventType: "resource-observation",
        payloadSha256: "e".repeat(64),
        expectedSequence: terminal.result.eventSequence,
        expectedHash: terminal.result.eventHash,
        terminal: false,
      },
    }),
    (error) => error.code === "DISTRIBUTED_RUN_TERMINAL",
  );
  await plane.close();
});

test("distributed conversation claims isolate runs and replace only terminal owners", async () => {
  const stateDir = await tempDir("codex-chat-control-conversation-");
  const plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => Date.parse("2026-07-30T02:00:00.000Z"),
    randomId: deterministicIds("lease-conversation-a", "lease-conversation-b"),
  });
  async function acquire(runId, ownerId, idempotencyKey) {
    return (await plane.execute({
      operation: "lease.acquire",
      idempotencyKey,
      data: {
        workspaceId: "workspace-conversation",
        runId,
        ownerId,
        ttlMs: 60_000,
      },
    })).result;
  }
  const first = await acquire(
    "run-conversation-a",
    "coordinator-conversation-a",
    "conversation-acquire-a",
  );
  const second = await acquire(
    "run-conversation-b",
    "coordinator-conversation-b",
    "conversation-acquire-b",
  );
  const descriptor = {
    providerNamespace: "chatgpt",
    type: "conversation-identity",
    value: "provider-conversation-shared",
  };
  const claimed = await plane.execute({
    operation: "conversation.claim",
    idempotencyKey: "conversation-claim-a",
    data: { ...first, descriptor },
  });
  assert.equal(claimed.result.generation, 1);
  assert.equal(claimed.result.runId, "run-conversation-a");

  await assert.rejects(
    plane.execute({
      operation: "conversation.claim",
      idempotencyKey: "conversation-claim-b-conflict",
      data: { ...second, descriptor },
    }),
    (error) => error.code === "CONVERSATION_LEASE_CONFLICT",
  );

  const terminal = await plane.execute({
    operation: "run.append",
    idempotencyKey: "conversation-terminal-a",
    data: {
      ...first,
      eventId: "conversation-event-terminal",
      eventType: "blocked",
      payloadSha256: "f".repeat(64),
      expectedSequence: 0,
      expectedHash: null,
      terminal: true,
    },
  });
  assert.equal(terminal.result.terminal, true);
  await assert.rejects(
    plane.execute({
      operation: "conversation.claim",
      idempotencyKey: "conversation-terminal-reclaim-a",
      data: { ...first, descriptor },
    }),
    (error) => error.code === "DISTRIBUTED_RUN_TERMINAL",
  );
  const replaced = await plane.execute({
    operation: "conversation.claim",
    idempotencyKey: "conversation-claim-b-after-terminal",
    data: { ...second, descriptor },
  });
  assert.equal(replaced.result.generation, 2);
  assert.equal(replaced.result.runId, "run-conversation-b");
  assert.equal(replaced.result.fencingToken, second.fencingToken);
  await plane.close();
});

test("partitioned mailboxes enforce backpressure, claim ownership, and redelivery", async () => {
  const stateDir = await tempDir("codex-chat-control-mailbox-");
  let nowMs = Date.parse("2026-07-30T03:00:00.000Z");
  const plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => nowMs,
    randomId: deterministicIds(
      "lease-mailbox",
      "claim-message-one",
      "claim-message-two",
    ),
    limits: {
      mailbox: {
        maxQueuedMessages: 2,
        maxQueuedBytes: 1024,
        maxInFlight: 1,
        maxMessageBytes: 512,
        minVisibilityTimeoutMs: 1_000,
        maxVisibilityTimeoutMs: 60_000,
      },
    },
  });
  const lease = (await plane.execute({
    operation: "lease.acquire",
    idempotencyKey: "mailbox-acquire",
    data: {
      workspaceId: "workspace-mailbox",
      runId: "run-mailbox",
      ownerId: "coordinator-mailbox",
      ttlMs: 60_000,
    },
  })).result;
  const runHead = (await plane.execute({
    operation: "run.append",
    idempotencyKey: "mailbox-run-head",
    data: {
      ...lease,
      eventId: "mailbox-prepared",
      eventType: "prepared",
      payloadSha256: "1".repeat(64),
      expectedSequence: 0,
      expectedHash: null,
      terminal: false,
    },
  })).result;
  const route = {
    workspaceId: "workspace-mailbox",
    coordinatorId: "coordinator-mailbox",
    runId: "run-mailbox",
    workUnitId: "work-unit-mailbox",
    agentId: "agent-mailbox",
  };
  async function enqueue(index) {
    const payload = { task: `task-${index}` };
    return plane.execute({
      operation: "mail.enqueue",
      idempotencyKey: `mailbox-enqueue-${index}`,
      data: {
        ...lease,
        route,
        messageId: `message-${index}`,
        correlationId: "correlation-mailbox",
        causalParentId: null,
        senderId: "coordinator-mailbox",
        payload,
        payloadSha256: sha256(JSON.stringify(payload)),
        expectedRunHead: {
          eventSequence: runHead.eventSequence,
          eventHash: runHead.eventHash,
        },
      },
    });
  }
  assert.equal((await enqueue(1)).result.status, "queued");
  assert.equal((await enqueue(2)).result.status, "queued");
  await assert.rejects(
    enqueue(3),
    (error) => error.code === "MAILBOX_BACKPRESSURE",
  );

  const firstClaim = await plane.execute({
    operation: "mail.claim",
    idempotencyKey: "mailbox-claim-first",
    data: {
      ...lease,
      route,
      consumerId: "agent-process-one",
      visibilityTimeoutMs: 1_000,
    },
  });
  assert.equal(firstClaim.result.message.messageId, "message-1");
  assert.equal(firstClaim.result.message.status, "in_flight");
  assert.equal(firstClaim.result.claimToken, "claim-message-one");
  await assert.rejects(
    plane.execute({
      operation: "mail.claim",
      idempotencyKey: "mailbox-claim-over-limit",
      data: {
        ...lease,
        route,
        consumerId: "agent-process-two",
        visibilityTimeoutMs: 1_000,
      },
    }),
    (error) => error.code === "MAILBOX_IN_FLIGHT_LIMIT",
  );
  await assert.rejects(
    plane.execute({
      operation: "mail.ack",
      idempotencyKey: "mailbox-ack-crossed",
      data: {
        ...lease,
        route,
        messageId: "message-1",
        consumerId: "agent-process-two",
        claimToken: "claim-message-one",
      },
    }),
    (error) => error.code === "MAILBOX_CLAIM_CONFLICT",
  );

  nowMs += 1_001;
  const redelivered = await plane.execute({
    operation: "mail.claim",
    idempotencyKey: "mailbox-claim-redelivered",
    data: {
      ...lease,
      route,
      consumerId: "agent-process-two",
      visibilityTimeoutMs: 1_000,
    },
  });
  assert.equal(redelivered.result.message.messageId, "message-1");
  assert.equal(redelivered.result.message.deliveryAttempt, 2);
  assert.equal(redelivered.result.claimToken, "claim-message-two");
  const acknowledged = await plane.execute({
    operation: "mail.ack",
    idempotencyKey: "mailbox-ack-redelivered",
    data: {
      ...lease,
      route,
      messageId: "message-1",
      consumerId: "agent-process-two",
      claimToken: "claim-message-two",
    },
  });
  assert.equal(acknowledged.result.status, "acknowledged");
  await plane.close();
});

test("empty mailbox peeks consume no mutation or idempotency capacity", async () => {
  const stateDir = await tempDir("codex-chat-control-mailbox-peek-empty-");
  const plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => Date.parse("2026-07-30T03:15:00.000Z"),
    randomId: deterministicIds("lease-mailbox-peek-empty"),
  });
  const lease = (await plane.execute({
    operation: "lease.acquire",
    idempotencyKey: "mailbox-peek-empty-acquire",
    data: {
      workspaceId: "workspace-mailbox-peek-empty",
      runId: "run-mailbox-peek-empty",
      ownerId: "coordinator-mailbox-peek-empty",
      ttlMs: 60_000,
    },
  })).result;
  const route = {
    workspaceId: "workspace-mailbox-peek-empty",
    coordinatorId: "coordinator-mailbox-peek-empty",
    runId: "run-mailbox-peek-empty",
    workUnitId: "work-unit-mailbox-peek-empty",
    agentId: "agent-mailbox-peek-empty",
  };

  for (let index = 0; index < 100_000; index += 1) {
    const peek = await plane.execute({
      operation: "mail.peek",
      data: { ...lease, route },
    });
    assert.equal(peek.sequence, 1);
    assert.equal(peek.idempotent, false);
    assert.deepEqual(peek.result, {
      route,
      candidate: null,
    });
  }
  await plane.close();

  const events = (await readFile(path.join(stateDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n");
  assert.equal(events.length, 1);
  const snapshot = JSON.parse(
    await readFile(path.join(stateDir, "state.json"), "utf8"),
  );
  assert.equal(snapshot.sequence, 1);
  assert.deepEqual(Object.keys(snapshot.idempotencyRecords), [
    "mailbox-peek-empty-acquire",
  ]);
});

test("mail claims can bind the exact peeked candidate across races and redelivery", async () => {
  const stateDir = await tempDir("codex-chat-control-mailbox-peek-claim-");
  let nowMs = Date.parse("2026-07-30T03:20:00.000Z");
  const plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => nowMs,
    randomId: deterministicIds(
      "lease-mailbox-peek-claim",
      "claim-mailbox-race-winner",
      "claim-mailbox-redelivery",
    ),
    limits: {
      mailbox: {
        maxInFlight: 1,
      },
    },
  });
  const lease = (await plane.execute({
    operation: "lease.acquire",
    idempotencyKey: "mailbox-peek-claim-acquire",
    data: {
      workspaceId: "workspace-mailbox-peek-claim",
      runId: "run-mailbox-peek-claim",
      ownerId: "coordinator-mailbox-peek-claim",
      ttlMs: 60_000,
    },
  })).result;
  const head = (await plane.execute({
    operation: "run.append",
    idempotencyKey: "mailbox-peek-claim-head",
    data: {
      ...lease,
      eventId: "mailbox-peek-claim-prepared",
      eventType: "prepared",
      payloadSha256: "7".repeat(64),
      expectedSequence: 0,
      expectedHash: null,
      terminal: false,
    },
  })).result;
  const route = {
    workspaceId: "workspace-mailbox-peek-claim",
    coordinatorId: "coordinator-mailbox-peek-claim",
    runId: "run-mailbox-peek-claim",
    workUnitId: "work-unit-mailbox-peek-claim",
    agentId: "agent-mailbox-peek-claim",
  };
  const payload = { task: "peek-then-claim" };
  await plane.execute({
    operation: "mail.enqueue",
    idempotencyKey: "mailbox-peek-claim-enqueue",
    data: {
      ...lease,
      route,
      messageId: "message-mailbox-peek-claim",
      correlationId: "correlation-mailbox-peek-claim",
      causalParentId: null,
      senderId: "coordinator-mailbox-peek-claim",
      payload,
      payloadSha256: sha256(JSON.stringify(payload)),
      expectedRunHead: {
        eventSequence: head.eventSequence,
        eventHash: head.eventHash,
      },
    },
  });
  const peeked = await plane.execute({
    operation: "mail.peek",
    data: { ...lease, route },
  });
  assert.deepEqual(peeked.result.candidate, {
    messageId: "message-mailbox-peek-claim",
    deliveryAttempt: 0,
  });

  await plane.execute({
    operation: "mail.claim",
    idempotencyKey: "mailbox-peek-claim-race-winner",
    data: {
      ...lease,
      route,
      consumerId: "agent-process-race-winner",
      visibilityTimeoutMs: 1_000,
    },
  });
  await assert.rejects(
    plane.execute({
      operation: "mail.claim",
      idempotencyKey: "mailbox-peek-claim-race-loser",
      data: {
        ...lease,
        route,
        consumerId: "agent-process-race-loser",
        visibilityTimeoutMs: 1_000,
        expectedMessageId: peeked.result.candidate.messageId,
        expectedDeliveryAttempt: peeked.result.candidate.deliveryAttempt,
      },
    }),
    (error) => error.code === "MAILBOX_AVAILABILITY_STALE",
  );

  nowMs += 1_001;
  const redeliveryPeek = await plane.execute({
    operation: "mail.peek",
    data: { ...lease, route },
  });
  assert.deepEqual(redeliveryPeek.result.candidate, {
    messageId: "message-mailbox-peek-claim",
    deliveryAttempt: 1,
  });
  const redelivered = await plane.execute({
    operation: "mail.claim",
    idempotencyKey: "mailbox-peek-claim-redelivery",
    data: {
      ...lease,
      route,
      consumerId: "agent-process-redelivery",
      visibilityTimeoutMs: 1_000,
      expectedMessageId: redeliveryPeek.result.candidate.messageId,
      expectedDeliveryAttempt:
        redeliveryPeek.result.candidate.deliveryAttempt,
    },
  });
  assert.equal(
    redelivered.result.message.messageId,
    "message-mailbox-peek-claim",
  );
  assert.equal(redelivered.result.message.deliveryAttempt, 2);
  assert.equal(redelivered.result.claimToken, "claim-mailbox-redelivery");
  await plane.close();
});

test("mailbox pruning bounds retained payloads without allowing message ID reuse", async () => {
  const stateDir = await tempDir("codex-chat-control-prune-");
  let nowMs = Date.parse("2026-07-30T03:30:00.000Z");
  let plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => nowMs,
    randomId: deterministicIds("lease-prune", "claim-prune"),
    limits: {
      mailbox: {
        maxRetainedMessages: 2,
        maxPruneBatch: 2,
      },
    },
  });
  const lease = (await plane.execute({
    operation: "lease.acquire",
    idempotencyKey: "prune-acquire",
    data: {
      workspaceId: "workspace-prune",
      runId: "run-prune",
      ownerId: "coordinator-prune",
      ttlMs: 60_000,
    },
  })).result;
  const runHead = (await plane.execute({
    operation: "run.append",
    idempotencyKey: "prune-run-head",
    data: {
      ...lease,
      eventId: "prune-prepared",
      eventType: "prepared",
      payloadSha256: "3".repeat(64),
      expectedSequence: 0,
      expectedHash: null,
      terminal: false,
    },
  })).result;
  const route = {
    workspaceId: "workspace-prune",
    coordinatorId: "coordinator-prune",
    runId: "run-prune",
    workUnitId: "work-unit-prune",
    agentId: "agent-prune",
  };
  async function enqueue(messageId) {
    const payload = { task: messageId };
    return plane.execute({
      operation: "mail.enqueue",
      idempotencyKey: `prune-enqueue-${messageId}`,
      data: {
        ...lease,
        route,
        messageId,
        correlationId: "correlation-prune",
        causalParentId: null,
        senderId: "coordinator-prune",
        payload,
        payloadSha256: sha256(JSON.stringify(payload)),
        expectedRunHead: {
          eventSequence: runHead.eventSequence,
          eventHash: runHead.eventHash,
        },
      },
    });
  }
  await enqueue("message-prune-one");
  const claim = await plane.execute({
    operation: "mail.claim",
    idempotencyKey: "prune-claim-one",
    data: {
      ...lease,
      route,
      consumerId: "agent-process-prune",
      visibilityTimeoutMs: 10_000,
    },
  });
  await plane.execute({
    operation: "mail.ack",
    idempotencyKey: "prune-ack-one",
    data: {
      ...lease,
      route,
      messageId: "message-prune-one",
      consumerId: "agent-process-prune",
      claimToken: claim.result.claimToken,
    },
  });
  await enqueue("message-prune-two");
  await assert.rejects(
    enqueue("message-prune-three"),
    (error) => error.code === "MAILBOX_RETENTION_REQUIRED",
  );
  await assert.rejects(
    plane.execute({
      operation: "mail.prune",
      idempotencyKey: "prune-active-message",
      data: {
        ...lease,
        route,
        messageIds: ["message-prune-two"],
      },
    }),
    (error) => error.code === "MAILBOX_MESSAGE_NOT_FINAL",
  );
  const pruned = await plane.execute({
    operation: "mail.prune",
    idempotencyKey: "prune-final-message",
    data: {
      ...lease,
      route,
      messageIds: ["message-prune-one"],
    },
  });
  assert.deepEqual(pruned.result.prunedMessageIds, ["message-prune-one"]);
  assert.equal(pruned.result.remainingMessages, 1);
  await assert.rejects(
    plane.execute({
      operation: "mail.inspect",
      data: { route, messageId: "message-prune-one" },
    }),
    (error) => error.code === "MAILBOX_MESSAGE_NOT_FOUND",
  );
  await assert.rejects(
    plane.execute({
      operation: "mail.enqueue",
      idempotencyKey: "prune-reuse-message-id",
      data: {
        ...lease,
        route,
        messageId: "message-prune-one",
        correlationId: "correlation-prune",
        causalParentId: null,
        senderId: "coordinator-prune",
        payload: { task: "reused" },
        payloadSha256: sha256(JSON.stringify({ task: "reused" })),
        expectedRunHead: {
          eventSequence: runHead.eventSequence,
          eventHash: runHead.eventHash,
        },
      },
    }),
    (error) => error.code === "MAILBOX_MESSAGE_ID_CONFLICT",
  );
  await enqueue("message-prune-three");
  await plane.close();

  plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => nowMs,
    limits: {
      mailbox: {
        maxRetainedMessages: 2,
        maxPruneBatch: 2,
      },
    },
  });
  const listed = await plane.execute({
    operation: "mail.list",
    data: { route },
  });
  assert.deepEqual(
    listed.result.map((message) => message.messageId),
    ["message-prune-two", "message-prune-three"],
  );
  await plane.close();
});

test("distributed limit overrides may tighten but never weaken hard ceilings", async () => {
  const stateDir = await tempDir("codex-chat-control-limit-ceiling-");
  await assert.rejects(
    openCoordinationControlPlane({ stateDir: "" }),
    (error) => error.code === "COORDINATION_STATE_DIRECTORY_INVALID",
  );
  await assert.rejects(
    openCoordinationControlPlane({
      stateDir,
      limits: {
        mailbox: {
          maxQueuedMessages: 129,
        },
      },
    }),
    (error) => error.code === "COORDINATION_LIMITS_INVALID",
  );
  const plane = await openCoordinationControlPlane({ stateDir });
  const cyclic = {
    operation: "run.read",
    data: {
      workspaceId: "workspace-limits",
      runId: "run-limits",
    },
  };
  cyclic.data.cyclic = cyclic;
  await assert.rejects(
    plane.execute(cyclic),
    (error) => error.code === "COORDINATION_REQUEST_INVALID",
  );
  await assert.rejects(
    plane.execute({
      operation: "run.read",
      data: {
        workspaceId: "workspace-limits",
        runId: "run-limits",
        padding: "x".repeat(128 * 1024),
      },
    }),
    (error) => error.code === "COORDINATION_REQUEST_INVALID",
  );
  await plane.close();
});

test("protocol IDs that match object prototype names remain ordinary isolated IDs", async () => {
  const stateDir = await tempDir("codex-chat-control-prototype-ids-");
  const plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => Date.parse("2026-07-30T03:45:00.000Z"),
    randomId: deterministicIds("lease-prototype-ids"),
  });
  const lease = (await plane.execute({
    operation: "lease.acquire",
    idempotencyKey: "constructor",
    data: {
      workspaceId: "workspace-prototype-ids",
      runId: "run-prototype-ids",
      ownerId: "coordinator-prototype-ids",
      ttlMs: 60_000,
    },
  })).result;
  const head = (await plane.execute({
    operation: "run.append",
    idempotencyKey: "toString",
    data: {
      ...lease,
      eventId: "constructor",
      eventType: "prepared",
      payloadSha256: "5".repeat(64),
      expectedSequence: 0,
      expectedHash: null,
      terminal: false,
    },
  })).result;
  const route = {
    workspaceId: "workspace-prototype-ids",
    coordinatorId: "coordinator-prototype-ids",
    runId: "run-prototype-ids",
    workUnitId: "work-unit-prototype-ids",
    agentId: "agent-prototype-ids",
  };
  const payload = { task: "prototype-safe" };
  await plane.execute({
    operation: "mail.enqueue",
    idempotencyKey: "valueOf",
    data: {
      ...lease,
      route,
      messageId: "constructor",
      correlationId: "correlation-prototype-ids",
      causalParentId: null,
      senderId: "coordinator-prototype-ids",
      payload,
      payloadSha256: sha256(JSON.stringify(payload)),
      expectedRunHead: {
        eventSequence: head.eventSequence,
        eventHash: head.eventHash,
      },
    },
  });
  const inspected = await plane.execute({
    operation: "mail.inspect",
    data: { route, messageId: "constructor" },
  });
  assert.equal(inspected.result.payload.task, "prototype-safe");
  await plane.close();
});

test("coordinator takeover fences stale acknowledgements and persists cancellation", async () => {
  const stateDir = await tempDir("codex-chat-control-cancel-");
  let nowMs = Date.parse("2026-07-30T04:00:00.000Z");
  let plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => nowMs,
    randomId: deterministicIds(
      "lease-cancel-first",
      "claim-cancel-first",
      "lease-cancel-second",
    ),
  });
  const first = (await plane.execute({
    operation: "lease.acquire",
    idempotencyKey: "cancel-acquire-first",
    data: {
      workspaceId: "workspace-cancel",
      runId: "run-cancel",
      ownerId: "coordinator-cancel-first",
      ttlMs: 1_000,
    },
  })).result;
  const runHead = (await plane.execute({
    operation: "run.append",
    idempotencyKey: "cancel-run-head",
    data: {
      ...first,
      eventId: "cancel-prepared",
      eventType: "prepared",
      payloadSha256: "2".repeat(64),
      expectedSequence: 0,
      expectedHash: null,
      terminal: false,
    },
  })).result;
  const route = {
    workspaceId: "workspace-cancel",
    coordinatorId: "coordinator-cancel-first",
    runId: "run-cancel",
    workUnitId: "work-unit-cancel",
    agentId: "agent-cancel",
  };
  const payload = { task: "long-running-work" };
  await plane.execute({
    operation: "mail.enqueue",
    idempotencyKey: "cancel-enqueue",
    data: {
      ...first,
      route,
      messageId: "message-cancel",
      correlationId: "correlation-cancel",
      causalParentId: null,
      senderId: "coordinator-cancel-first",
      payload,
      payloadSha256: sha256(JSON.stringify(payload)),
      expectedRunHead: {
        eventSequence: runHead.eventSequence,
        eventHash: runHead.eventHash,
      },
    },
  });
  const claim = await plane.execute({
    operation: "mail.claim",
    idempotencyKey: "cancel-claim",
    data: {
      ...first,
      route,
      consumerId: "agent-process-cancel",
      visibilityTimeoutMs: 60_000,
    },
  });

  nowMs += 1_001;
  const second = (await plane.execute({
    operation: "lease.acquire",
    idempotencyKey: "cancel-acquire-second",
    data: {
      workspaceId: "workspace-cancel",
      runId: "run-cancel",
      ownerId: "coordinator-cancel-second",
      ttlMs: 60_000,
    },
  })).result;
  await assert.rejects(
    plane.execute({
      operation: "mail.ack",
      idempotencyKey: "cancel-stale-ack",
      data: {
        ...first,
        route,
        messageId: "message-cancel",
        consumerId: "agent-process-cancel",
        claimToken: claim.result.claimToken,
      },
    }),
    (error) => error.code === "STALE_FENCE",
  );
  const cancelled = await plane.execute({
    operation: "mail.cancel",
    idempotencyKey: "cancel-by-takeover",
    data: {
      ...second,
      route,
      messageId: "message-cancel",
      cancellationId: "cancellation-takeover",
      causalParentId: "message-cancel",
      reason: "Coordinator epoch was superseded.",
    },
  });
  assert.equal(cancelled.result.status, "cancelled");
  assert.equal(
    cancelled.result.cancellation.fencingToken,
    second.fencingToken,
  );
  await plane.close();

  plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => nowMs,
    randomId: deterministicIds(),
  });
  const inspected = await plane.execute({
    operation: "mail.inspect",
    data: { route, messageId: "message-cancel" },
  });
  assert.equal(inspected.result.status, "cancelled");
  assert.equal(
    inspected.result.cancellation.cancellationId,
    "cancellation-takeover",
  );
  const listed = await plane.execute({
    operation: "mail.list",
    data: { route },
  });
  assert.equal(listed.result.length, 1);
  assert.equal(listed.result[0].messageId, "message-cancel");
  assert.equal(listed.result[0].status, "cancelled");
  await plane.close();
});

test("explicit release hands coordinator and conversation authority forward", async () => {
  const stateDir = await tempDir("codex-chat-control-release-");
  const plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => Date.parse("2026-07-30T04:30:00.000Z"),
    randomId: deterministicIds(
      "lease-release-first",
      "lease-release-second",
      "lease-release-reacquired",
    ),
  });
  async function acquire(runId, ownerId, key) {
    return (await plane.execute({
      operation: "lease.acquire",
      idempotencyKey: key,
      data: {
        workspaceId: "workspace-release",
        runId,
        ownerId,
        ttlMs: 60_000,
      },
    })).result;
  }
  const first = await acquire(
    "run-release-first",
    "coordinator-release-first",
    "release-acquire-first",
  );
  const second = await acquire(
    "run-release-second",
    "coordinator-release-second",
    "release-acquire-second",
  );
  const descriptor = {
    providerNamespace: "chatgpt",
    type: "thread-id",
    value: "release-thread",
  };
  await plane.execute({
    operation: "conversation.claim",
    idempotencyKey: "release-conversation-claim-first",
    data: { ...first, descriptor },
  });
  await plane.execute({
    operation: "conversation.release",
    idempotencyKey: "release-conversation-first",
    data: { ...first, descriptor },
  });
  const transferred = await plane.execute({
    operation: "conversation.claim",
    idempotencyKey: "release-conversation-claim-second",
    data: { ...second, descriptor },
  });
  assert.equal(transferred.result.runId, "run-release-second");
  assert.equal(transferred.result.generation, 2);

  const released = await plane.execute({
    operation: "lease.release",
    idempotencyKey: "release-coordinator-first",
    data: { ...first },
  });
  assert.equal(released.result.status, "released");
  const reacquired = await acquire(
    "run-release-first",
    "coordinator-release-reacquired",
    "release-acquire-reacquired",
  );
  assert.equal(reacquired.coordinatorEpoch, 2);
  assert.equal(reacquired.fencingToken, 2);
  await plane.close();
});

test("write-ahead journal repairs snapshots and rejects altered history", async () => {
  const stateDir = await tempDir("codex-chat-control-journal-");
  let plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => Date.parse("2026-07-30T05:00:00.000Z"),
    randomId: deterministicIds("lease-journal"),
  });
  const lease = (await plane.execute({
    operation: "lease.acquire",
    idempotencyKey: "journal-acquire",
    data: {
      workspaceId: "workspace-journal",
      runId: "run-journal",
      ownerId: "coordinator-journal",
      ttlMs: 60_000,
    },
  })).result;
  const head = (await plane.execute({
    operation: "run.append",
    idempotencyKey: "journal-run-event",
    data: {
      ...lease,
      eventId: "journal-prepared",
      eventType: "prepared",
      payloadSha256: "3".repeat(64),
      expectedSequence: 0,
      expectedHash: null,
      terminal: false,
    },
  })).result;
  await plane.close();

  const eventPath = path.join(stateDir, "events.jsonl");
  const events = (await readFile(eventPath, "utf8")).trim().split("\n");
  assert.equal(events.length, 2);
  assert.equal(JSON.parse(events[1]).previousHash, JSON.parse(events[0]).hash);
  await writeFile(eventPath, `${events.join("\n")}\n{"partial"`);
  await writeFile(path.join(stateDir, "state.json"), "corrupt snapshot\n");

  plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => Date.parse("2026-07-30T05:00:01.000Z"),
    randomId: deterministicIds(),
  });
  const recovered = await plane.execute({
    operation: "run.read",
    data: {
      workspaceId: "workspace-journal",
      runId: "run-journal",
    },
  });
  assert.equal(recovered.result.eventSequence, head.eventSequence);
  assert.equal(recovered.result.eventHash, head.eventHash);
  await plane.close();
  assert.equal(
    (await readFile(eventPath, "utf8")).trim().split("\n").length,
    2,
  );
  assert.equal(
    (await readdir(stateDir)).some((name) =>
      /^events\.partial-[a-f0-9]{64}\.bin$/.test(name)
    ),
    true,
  );

  const changed = JSON.parse(events[0]);
  changed.request.data.ownerId = "coordinator-altered";
  events[0] = JSON.stringify(changed);
  await writeFile(eventPath, `${events.join("\n")}\n`);
  await assert.rejects(
    openCoordinationControlPlane({
      stateDir,
      clock: () => Date.parse("2026-07-30T05:00:02.000Z"),
      randomId: deterministicIds(),
    }),
    (error) => error.code === "COORDINATION_EVENT_HASH_INVALID",
  );
});

test("control-plane state files reject symlinks instead of following them", async () => {
  const stateDir = await tempDir("codex-chat-control-state-symlink-");
  const outsideDir = await tempDir("codex-chat-control-state-outside-");
  const outside = await writeFixture(outsideDir, "outside.jsonl", "");
  await symlink(outside, path.join(stateDir, "events.jsonl"));
  await assert.rejects(
    openCoordinationControlPlane({ stateDir }),
    (error) => error.code === "COORDINATION_STATE_FILE_INVALID",
  );
  assert.equal(await readFile(outside, "utf8"), "");
});

test("authenticated network control plane serializes remote coordinators", async (t) => {
  const stateDir = await tempDir("codex-chat-control-http-");
  const plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => Date.parse("2026-07-30T06:00:00.000Z"),
    randomId: deterministicIds("lease-http-first", "lease-http-race"),
  });
  const token = "test-control-token-with-at-least-32-bytes";
  const server = await startCoordinationHttpServer({
    controlPlane: plane,
    host: "127.0.0.1",
    port: 0,
    token,
  });
  t.after(async () => {
    await server.close();
    await plane.close();
  });

  await assert.rejects(
    executeRemoteCoordination({
      endpoint: server.endpoint,
      token: "wrong-control-token-with-at-least-32b",
      request: {
        operation: "run.read",
        data: { workspaceId: "workspace-http", runId: "run-http" },
      },
    }),
    (error) => error.code === "CONTROL_AUTH_FAILED",
  );

  const first = await executeRemoteCoordination({
    endpoint: server.endpoint,
    token,
    request: {
      operation: "lease.acquire",
      idempotencyKey: "http-acquire-first",
      data: {
        workspaceId: "workspace-http",
        runId: "run-http",
        ownerId: "coordinator-http",
        ttlMs: 60_000,
      },
    },
  });
  assert.equal(first.result.fencingToken, 1);
  const appended = await executeRemoteCoordination({
    endpoint: server.endpoint,
    token,
    request: {
      operation: "run.append",
      idempotencyKey: "http-run-append",
      data: {
        ...first.result,
        eventId: "http-prepared",
        eventType: "prepared",
        payloadSha256: "4".repeat(64),
        expectedSequence: 0,
        expectedHash: null,
        terminal: false,
      },
    },
  });
  assert.equal(appended.result.eventSequence, 1);
  const cliRequest = await writeFixture(
    await tempDir("codex-chat-control-cli-request-"),
    "request.json",
    `${JSON.stringify({
      operation: "run.read",
      data: { workspaceId: "workspace-http", runId: "run-http" },
    })}\n`,
  );
  const cli = await runCli(
    [
      "control",
      "--endpoint", server.endpoint,
      "--request", cliRequest,
    ],
    { env: { CODEX_CHAT_CONTROL_TOKEN: token } },
  );
  assert.equal(cli.code, 0, JSON.stringify(cli.json));
  assert.equal(cli.json.command, "control");
  assert.equal(cli.json.data.result.eventHash, appended.result.eventHash);

  const contenders = await Promise.allSettled([
    executeRemoteCoordination({
      endpoint: server.endpoint,
      token,
      request: {
        operation: "lease.acquire",
        idempotencyKey: "http-race-a",
        data: {
          workspaceId: "workspace-http",
          runId: "run-race",
          ownerId: "coordinator-http-a",
          ttlMs: 60_000,
        },
      },
    }),
    executeRemoteCoordination({
      endpoint: server.endpoint,
      token,
      request: {
        operation: "lease.acquire",
        idempotencyKey: "http-race-b",
        data: {
          workspaceId: "workspace-http",
          runId: "run-race",
          ownerId: "coordinator-http-b",
          ttlMs: 60_000,
        },
      },
    }),
  ]);
  assert.equal(
    contenders.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  assert.equal(
    contenders.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason.code === "COORDINATOR_LEASE_HELD",
    ).length,
    1,
  );

  await assert.rejects(
    executeRemoteCoordination({
      endpoint: "http://control.example.test:8080",
      token,
      request: {
        operation: "run.read",
        data: { workspaceId: "workspace-http", runId: "run-http" },
      },
    }),
    (error) => error.code === "CONTROL_TLS_REQUIRED",
  );
});

test("concurrent independent coordinators survive restart without crossed results", async () => {
  const stateDir = await tempDir("codex-chat-control-concurrency-");
  const nowMs = Date.parse("2026-07-30T06:30:00.000Z");
  let plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => nowMs,
  });
  const requests = Array.from({ length: 32 }, (_, index) => ({
    operation: "lease.acquire",
    idempotencyKey: `concurrent-acquire-${index}`,
    data: {
      workspaceId: "workspace-concurrent",
      runId: `run-concurrent-${index}`,
      ownerId: `coordinator-concurrent-${index}`,
      ttlMs: 60_000,
    },
  }));
  const results = await Promise.all(
    requests.map((request) => plane.execute(request)),
  );
  assert.deepEqual(
    results.map((result) => result.sequence).sort((a, b) => a - b),
    Array.from({ length: 32 }, (_, index) => index + 1),
  );
  assert.equal(
    new Set(results.map((result) => result.result.leaseId)).size,
    32,
  );
  await plane.close();

  plane = await openCoordinationControlPlane({
    stateDir,
    clock: () => nowMs + 1_000,
  });
  const replayed = await Promise.all(
    requests.map((request) => plane.execute(request)),
  );
  assert.equal(replayed.every((result) => result.idempotent), true);
  assert.deepEqual(
    replayed.map((result) => result.result.leaseId),
    results.map((result) => result.result.leaseId),
  );
  await plane.close();
});

test("network control plane enforces TLS placement, rate, and body limits", async (t) => {
  const stateDir = await tempDir("codex-chat-control-http-limits-");
  const plane = await openCoordinationControlPlane({
    stateDir,
    randomId: deterministicIds(),
  });
  const token = "limit-control-token-with-at-least-32-bytes";
  await assert.rejects(
    startCoordinationHttpServer({
      controlPlane: plane,
      host: "0.0.0.0",
      port: 0,
      token,
    }),
    (error) => error.code === "CONTROL_TLS_REQUIRED",
  );
  await assert.rejects(
    startCoordinationHttpServer({
      controlPlane: plane,
      host: "127.0.0.1",
      port: 0,
      token,
      tls: {
        key: "invalid-test-key",
        cert: "invalid-test-cert",
        requestCert: true,
      },
    }),
    (error) => error.code === "CONTROL_TLS_CONFIG_INVALID",
  );
  const server = await startCoordinationHttpServer({
    controlPlane: plane,
    host: "127.0.0.1",
    port: 0,
    token,
    rateLimit: { maxRequests: 1, windowMs: 60_000 },
  });
  t.after(async () => {
    await server.close();
    await plane.close();
  });
  const query = {
    operation: "run.read",
    data: { workspaceId: "workspace-limits", runId: "run-limits" },
  };
  await assert.rejects(
    executeRemoteCoordination({
      endpoint: "https://control.invalid:9443",
      token,
      request: query,
      cert: "client-certificate",
    }),
    (error) => error.code === "CONTROL_TLS_CONFIG_INVALID",
  );
  await assert.rejects(
    executeRemoteCoordination({
      endpoint: server.endpoint,
      token: "é".repeat(32),
      request: query,
    }),
    (error) => error.code === "CONTROL_TOKEN_INVALID",
  );
  await assert.rejects(
    executeRemoteCoordination({
      endpoint: "http://localhost:9443",
      token,
      request: query,
    }),
    (error) => error.code === "CONTROL_TLS_REQUIRED",
  );
  assert.equal(
    (await executeRemoteCoordination({
      endpoint: server.endpoint,
      token,
      request: query,
    })).result,
    null,
  );
  await assert.rejects(
    executeRemoteCoordination({
      endpoint: server.endpoint,
      token,
      request: query,
    }),
    (error) => error.code === "CONTROL_RATE_LIMITED",
  );
  await assert.rejects(
    executeRemoteCoordination({
      endpoint: server.endpoint,
      token,
      request: {
        operation: "run.read",
        data: {
          workspaceId: "workspace-limits",
          runId: "run-limits",
          oversized: "x".repeat(129 * 1024),
        },
      },
    }),
    (error) => error.code === "CONTROL_REQUEST_TOO_LARGE",
  );
});

test("network control plane rejects invalid UTF-8 before request validation", async (t) => {
  const stateDir = await tempDir("codex-chat-control-http-utf8-");
  const plane = await openCoordinationControlPlane({ stateDir });
  const token = "utf8-control-token-with-at-least-32-bytes";
  const server = await startCoordinationHttpServer({
    controlPlane: plane,
    host: "127.0.0.1",
    port: 0,
    token,
  });
  t.after(async () => {
    await server.close();
    await plane.close();
  });
  const body = Buffer.from([
    ...Buffer.from('{"operation":"run.read","data":{"padding":"'),
    0xff,
    ...Buffer.from('"}}'),
  ]);
  const response = await new Promise((resolve, reject) => {
    const request = http.request(
      `${server.endpoint}/v1/execute`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-length": String(body.byteLength),
          "content-type": "application/json",
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => {
          resolve({
            statusCode: incoming.statusCode,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
  assert.equal(response.statusCode, 400);
  assert.equal(
    JSON.parse(response.body).error.code,
    "CONTROL_JSON_INVALID",
  );
});

test("network control plane completes a mutual-TLS request", async (t) => {
  const certificateDir = await tempDir("codex-chat-control-mtls-");
  const serverKey = path.join(certificateDir, "server.key");
  const serverCert = path.join(certificateDir, "server.crt");
  const clientKey = path.join(certificateDir, "client.key");
  const clientCert = path.join(certificateDir, "client.crt");
  try {
    await runExecutable("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", serverKey,
      "-out", serverCert,
      "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
      "-days", "1",
      "-sha256",
    ]);
    await runExecutable("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", clientKey,
      "-out", clientCert,
      "-subj", "/CN=codex-chat-test-client",
      "-days", "1",
      "-sha256",
    ]);
  } catch {
    t.skip("openssl certificate generation is unavailable");
    return;
  }
  const stateDir = await tempDir("codex-chat-control-mtls-state-");
  const plane = await openCoordinationControlPlane({ stateDir });
  const token = "mtls-control-token-with-at-least-32-bytes";
  const server = await startCoordinationHttpServer({
    controlPlane: plane,
    host: "127.0.0.1",
    port: 0,
    token,
    tls: {
      key: await readFile(serverKey),
      cert: await readFile(serverCert),
      ca: await readFile(clientCert),
      requestCert: true,
    },
  });
  t.after(async () => {
    await server.close();
    await plane.close();
  });
  const request = {
    operation: "run.read",
    data: {
      workspaceId: "workspace-mtls",
      runId: "run-mtls",
    },
  };
  await assert.rejects(
    executeRemoteCoordination({
      endpoint: server.endpoint,
      token,
      request,
      ca: await readFile(serverCert),
    }),
  );
  const response = await executeRemoteCoordination({
    endpoint: server.endpoint,
    token,
    request,
    ca: await readFile(serverCert),
    key: await readFile(clientKey),
    cert: await readFile(clientCert),
  });
  assert.equal(response.result, null);
});

test("remote coordination client supports bracketed IPv6 loopback endpoints", async (t) => {
  const stateDir = await tempDir("codex-chat-control-http-ipv6-");
  const plane = await openCoordinationControlPlane({ stateDir });
  const token = "ipv6-control-token-with-at-least-32-bytes";
  let server;
  try {
    server = await startCoordinationHttpServer({
      controlPlane: plane,
      host: "::1",
      port: 0,
      token,
    });
  } catch (error) {
    await plane.close();
    if (["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(error.code)) {
      t.skip("IPv6 loopback is unavailable");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await server.close();
    await plane.close();
  });
  const response = await executeRemoteCoordination({
    endpoint: server.endpoint,
    token,
    request: {
      operation: "run.read",
      data: {
        workspaceId: "workspace-ipv6",
        runId: "run-ipv6",
      },
    },
  });
  assert.equal(response.result, null);
});

test("remote coordination client timeout is absolute under trickled responses", async (t) => {
  const slowServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const ticker = setInterval(() => response.write(" "), 10);
    const completion = setTimeout(() => {
      clearInterval(ticker);
      response.end(JSON.stringify({
        schema: "codex-chat/control/v1",
        ok: true,
        data: { sequence: 0, idempotent: false, result: null },
      }));
    }, 250);
    response.once("close", () => {
      clearInterval(ticker);
      clearTimeout(completion);
    });
  });
  await new Promise((resolve, reject) => {
    slowServer.once("error", reject);
    slowServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      slowServer.close((error) => error ? reject(error) : resolve());
    });
  });
  const address = slowServer.address();
  await assert.rejects(
    executeRemoteCoordination({
      endpoint: `http://127.0.0.1:${address.port}`,
      token: "timeout-control-token-with-at-least-32-bytes",
      timeoutMs: 50,
      request: {
        operation: "run.read",
        data: {
          workspaceId: "workspace-timeout",
          runId: "run-timeout",
        },
      },
    }),
    (error) => error.code === "CONTROL_TIMEOUT",
  );
});
