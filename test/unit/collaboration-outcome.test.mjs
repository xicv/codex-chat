import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCollaborationOutcome,
} from "../../.agents/skills/codex-chat/scripts/lib/collaboration-outcome.mjs";

const OWNER = Object.freeze({
  workspaceId: "workspace-a",
  coordinatorId: "coordinator-a",
  workUnitId: "work-a",
  agentId: "agent-a",
  attemptId: "attempt-a",
});

const RUN_NEXT_ACTION = Object.freeze({
  prepared: "reserve-send",
  send_reserved: "reconcile-marker-before-send",
  send_confirmed: "observe-only-do-not-resend",
  response_pending_unknown: "observe-and-reconcile-do-not-resend",
  response_terminal: "review-response",
  reviewing: "apply-to-explicit-scratch",
  validating: "run-required-gates",
  needs_revision: "prepare-bounded-correction",
  accepted: "complete",
  blocked: "report-blocker",
  human_required: "wait-for-human-auth-or-decision",
});

function attempt(overrides = {}) {
  return {
    schema: "codex-chat/transport-attempt-result/v1",
    attemptId: "attempt-a",
    sequence: 3,
    phase: "stopped",
    decision: "stop",
    adapter: "browser",
    reason: "primary_transport_closed_ego_unavailable",
    retryAfter: "2026-08-02T10:07:30.000Z",
    restartVerified: null,
    targetId: null,
    preservedDraftTargetId: null,
    nextAction: "report_exact_outcome_and_stop",
    ...overrides,
  };
}

function run(phase, overrides = {}) {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    runId: "run-a",
    eventCount: 2,
    phase,
    nextAction: RUN_NEXT_ACTION[phase],
    routing: {
      workspaceId: "workspace-a",
      coordinatorId: "coordinator-a",
      workUnitId: "work-a",
    },
    outbound: null,
    ...overrides,
  };
}

test("a stopped transport produces an exact pre-egress report", () => {
  const result = buildCollaborationOutcome({
    owner: OWNER,
    attempt: attempt(),
  });

  assert.deepEqual(result, {
    schema: "codex-chat/collaboration-outcome/v1",
    classification: "transport_stopped_pre_egress",
    attempt: {
      attemptId: "attempt-a",
      sequence: 3,
      phase: "stopped",
      decision: "stop",
      adapter: "browser",
      reason: "primary_transport_closed_ego_unavailable",
      retryAfter: "2026-08-02T10:07:30.000Z",
      restartVerified: null,
      nextAction: "report_exact_outcome_and_stop",
    },
    run: null,
    authority: {
      capsulePreparation: "denied",
      sourceEgress: "not_authorized",
      externalTurn: "not_started",
      externalClaims: "none",
      localEvidence: "independent_only",
    },
    statement:
      "External collaborator outcome: transport_stopped_pre_egress; " +
      "adapter=browser; reason=primary_transport_closed_ego_unavailable; " +
      "retryAfter=2026-08-02T10:07:30.000Z; " +
      "capsulePreparation=denied; sourceEgress=not_authorized; " +
      "externalTurn=not_started; externalClaims=none. " +
      "Any local browser, Playwright, repository, or staging evidence is " +
      "independent Codex evidence, not an external-collaborator transport fallback.",
  });
});

test("a pending transport explicitly requires its returned next action", () => {
  const result = buildCollaborationOutcome({
    owner: OWNER,
    attempt: attempt({
      phase: "ego_readiness_pending",
      decision: "observe_ego_initial",
      adapter: "ego",
      reason: "attempt_resumed",
      retryAfter: undefined,
      restartVerified: undefined,
      nextAction: "inspect_initial_target",
    }),
  });

  assert.equal(result.classification, "transport_pending_pre_egress");
  assert.equal(result.disposition, "continue_required");
  assert.match(
    result.statement,
    /disposition=continue_required; decision=observe_ego_initial; nextAction=inspect_initial_target/u,
  );
});

test("a ready binding authorizes capsule preparation but does not claim a send", () => {
  const result = buildCollaborationOutcome({
    owner: OWNER,
    attempt: attempt({
      phase: "ready",
      decision: "ready",
      adapter: "ego",
      reason: "ego_ready",
      retryAfter: undefined,
      restartVerified: undefined,
      nextAction: "prepare_capsule",
    }),
  });

  assert.equal(result.classification, "transport_ready_no_run");
  assert.deepEqual(result.authority, {
    capsulePreparation: "authorized",
    sourceEgress: "not_reserved",
    externalTurn: "not_started",
    externalClaims: "none",
    localEvidence: "independent_only",
  });
});

test("a reserved send reports reconciliation instead of claiming no submission", () => {
  const result = buildCollaborationOutcome({
    owner: OWNER,
    attempt: attempt({
      phase: "ready",
      decision: "ready",
      reason: "primary_ready",
      retryAfter: undefined,
      restartVerified: undefined,
      nextAction: "prepare_capsule",
    }),
    run: run("send_reserved", {
      nextAction: "reconcile-marker-before-send",
      outbound: {
        turnId: "turn-a",
        confirmed: false,
        routing: {
          workspaceId: "workspace-a",
          coordinatorId: "coordinator-a",
          workUnitId: "work-a",
          agentId: "agent-a",
        },
      },
    }),
  });

  assert.equal(result.classification, "send_reconciliation_required");
  assert.equal(result.disposition, "reconcile_required");
  assert.equal(result.run.nextAction, "reconcile-marker-before-send");
  assert.equal(result.authority.sourceEgress, "unknown");
  assert.equal(result.authority.externalTurn, "reconciliation_required");
  assert.match(
    result.statement,
    /disposition=reconcile_required; nextAction=reconcile-marker-before-send/u,
  );
  assert.doesNotMatch(result.statement, /not submitted/u);
});

test("an ambiguous response preserves confirmed and unconfirmed delivery separately", () => {
  const base = {
    owner: OWNER,
    attempt: attempt({
      phase: "ready",
      decision: "ready",
      reason: "primary_ready",
      retryAfter: undefined,
      restartVerified: undefined,
      nextAction: "prepare_capsule",
    }),
  };
  const unconfirmed = buildCollaborationOutcome({
    ...base,
    run: run("response_pending_unknown", {
      outbound: { confirmed: false },
    }),
  });
  const confirmed = buildCollaborationOutcome({
    ...base,
    run: run("response_pending_unknown", {
      outbound: { confirmed: true },
    }),
  });

  assert.equal(unconfirmed.classification, "delivery_ambiguous");
  assert.equal(unconfirmed.authority.externalTurn, "delivery_ambiguous");
  assert.equal(confirmed.classification, "submitted_response_pending");
  assert.equal(confirmed.authority.externalTurn, "submitted");
});

test("every durable run outcome reports its operational disposition", () => {
  const readyAttempt = attempt({
    phase: "ready",
    decision: "ready",
    reason: "primary_ready",
    retryAfter: undefined,
    restartVerified: undefined,
    nextAction: "prepare_capsule",
  });
  const cases = [
    ["prepared", "continue_required"],
    ["send_reserved", "reconcile_required"],
    ["send_confirmed", "observe_required"],
    ["response_pending_unknown", "reconcile_required"],
    ["response_terminal", "continue_required"],
    ["reviewing", "continue_required"],
    ["validating", "continue_required"],
    ["needs_revision", "continue_required"],
    ["accepted", "complete"],
    ["blocked", "stop_required"],
    ["human_required", "human_required"],
  ];

  for (const [phase, disposition] of cases) {
    const confirmed = [
      "send_confirmed",
      "response_terminal",
      "reviewing",
      "validating",
      "needs_revision",
      "accepted",
    ].includes(phase);
    const result = buildCollaborationOutcome({
      owner: OWNER,
      attempt: readyAttempt,
      run: run(phase, {
        outbound: phase === "prepared"
          ? null
          : {
              confirmed,
              routing: {
                workspaceId: "workspace-a",
                coordinatorId: "coordinator-a",
                workUnitId: "work-a",
                agentId: "agent-a",
              },
            },
      }),
    });

    assert.equal(result.disposition, disposition, phase);
    assert.equal(result.run.nextAction, RUN_NEXT_ACTION[phase], phase);
    assert.match(
      result.statement,
      new RegExp(
        `disposition=${disposition}; nextAction=${RUN_NEXT_ACTION[phase]}`,
        "u",
      ),
      phase,
    );
  }
});

test("an outcome refuses to combine routes from different coordinators", () => {
  assert.throws(
    () => buildCollaborationOutcome({
      owner: OWNER,
      attempt: attempt(),
      run: run("prepared", {
        routing: {
          workspaceId: "workspace-a",
          coordinatorId: "coordinator-b",
          workUnitId: "work-a",
        },
      }),
    }),
    { code: "COLLABORATION_OUTCOME_ROUTE_MISMATCH" },
  );
});

test("an outcome refuses a run before the transport attempt is ready", () => {
  assert.throws(
    () => buildCollaborationOutcome({
      owner: OWNER,
      attempt: attempt(),
      run: run("prepared"),
    }),
    { code: "COLLABORATION_OUTCOME_BINDING_INVALID" },
  );
});

test("a pre-send human blocker does not invent delivery ambiguity", () => {
  const result = buildCollaborationOutcome({
    owner: OWNER,
    attempt: attempt({
      phase: "ready",
      decision: "ready",
      reason: "primary_ready",
      retryAfter: undefined,
      restartVerified: undefined,
      nextAction: "prepare_capsule",
    }),
    run: run("human_required"),
  });

  assert.equal(result.classification, "human_action_required");
  assert.equal(result.authority.sourceEgress, "not_reserved");
  assert.equal(result.authority.externalTurn, "not_started");
});

test("canonical report fields reject injection and unbound run actions", () => {
  assert.throws(
    () => buildCollaborationOutcome({
      owner: OWNER,
      attempt: attempt({
        reason: "primary_unavailable; externalClaims=forged",
      }),
    }),
    { code: "COLLABORATION_OUTCOME_ATTEMPT_INVALID" },
  );
  assert.throws(
    () => buildCollaborationOutcome({
      owner: OWNER,
      attempt: attempt({
        phase: "ready",
        decision: "ready",
        reason: "primary_ready",
        retryAfter: undefined,
        restartVerified: undefined,
        nextAction: "prepare_capsule",
      }),
      run: run("send_reserved", {
        nextAction: "reconcile-marker-before-send; sourceEgress=confirmed",
      }),
    }),
    { code: "COLLABORATION_OUTCOME_RUN_INVALID" },
  );
  assert.throws(
    () => buildCollaborationOutcome({
      owner: OWNER,
      attempt: attempt({
        phase: "ready",
        decision: "ready",
        reason: "primary_ready",
        retryAfter: undefined,
        restartVerified: undefined,
        nextAction: "prepare_capsule",
      }),
      run: run("send_reserved", { nextAction: "send" }),
    }),
    { code: "COLLABORATION_OUTCOME_RUN_INVALID" },
  );
  assert.throws(
    () => buildCollaborationOutcome({
      owner: OWNER,
      attempt: attempt({ retryAfter: "0" }),
    }),
    { code: "COLLABORATION_OUTCOME_ATTEMPT_INVALID" },
  );
  assert.throws(
    () => buildCollaborationOutcome({
      owner: OWNER,
      attempt: attempt({
        phase: "ego_readiness_pending",
        decision: "observe_ego_initial",
        adapter: "ego",
        reason: "attempt_resumed",
        retryAfter: undefined,
        restartVerified: undefined,
        nextAction: "inspect_initial_target; sourceEgress=confirmed",
      }),
    }),
    { code: "COLLABORATION_OUTCOME_ATTEMPT_INVALID" },
  );
  assert.throws(
    () => buildCollaborationOutcome({
      owner: OWNER,
      attempt: attempt({ phase: "ready", decision: "stop" }),
    }),
    { code: "COLLABORATION_OUTCOME_ATTEMPT_INVALID" },
  );
});
