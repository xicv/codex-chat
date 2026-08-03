import { fail } from "./errors.mjs";

const ATTEMPT_SCHEMA = "codex-chat/transport-attempt-result/v1";
const RESULT_SCHEMA = "codex-chat/collaboration-outcome/v1";
const TEXT = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const TOKEN = /^[a-z][a-z0-9_]{0,127}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function validText(value) {
  return typeof value === "string" && TEXT.test(value);
}

function validateOwner(owner) {
  const keys = [
    "workspaceId",
    "coordinatorId",
    "workUnitId",
    "agentId",
    "attemptId",
  ];
  if (
    !owner ||
    typeof owner !== "object" ||
    Array.isArray(owner) ||
    Object.keys(owner).length !== keys.length ||
    keys.some((key) => !validText(owner[key]))
  ) {
    fail(
      "COLLABORATION_OUTCOME_OWNER_INVALID",
      "Collaboration outcome owner is malformed or contains unsupported fields.",
    );
  }
}

function validAttemptDecision(attempt) {
  if (attempt.decision === "recover") {
    return [
      "primary_probe_pending",
      "ego_readiness_pending",
    ].includes(attempt.phase);
  }
  return {
    primary_probe_pending: "probe_primary",
    primary_readiness_pending: "observe_primary_page",
    ego_readiness_pending: attempt.decision,
    ready: "ready",
    stopped: "stop",
  }[attempt.phase] === attempt.decision && (
    attempt.phase !== "ego_readiness_pending" ||
    ["observe_ego_initial", "observe_ego_fresh"].includes(attempt.decision)
  );
}

function validAttemptAdapter(attempt) {
  if (attempt.phase === "stopped") {
    return [null, "browser", "ego"].includes(attempt.adapter);
  }
  if (attempt.phase === "ego_readiness_pending") {
    return attempt.adapter === "ego";
  }
  if (attempt.phase === "ready") {
    return ["browser", "ego"].includes(attempt.adapter);
  }
  return attempt.adapter === "browser";
}

function validateAttempt(owner, attempt) {
  if (
    attempt?.schema !== ATTEMPT_SCHEMA ||
    attempt.attemptId !== owner.attemptId ||
    !Number.isSafeInteger(attempt.sequence) ||
    attempt.sequence < 1 ||
    ![
      "primary_probe_pending",
      "primary_readiness_pending",
      "ego_readiness_pending",
      "ready",
      "stopped",
    ].includes(attempt.phase) ||
    !TOKEN.test(attempt.decision ?? "") ||
    !TOKEN.test(attempt.reason ?? "") ||
    !TOKEN.test(attempt.nextAction ?? "") ||
    !validAttemptDecision(attempt) ||
    !validAttemptAdapter(attempt) ||
    (
      attempt.retryAfter !== undefined &&
      attempt.retryAfter !== null &&
      (
        !RFC3339.test(attempt.retryAfter) ||
        !Number.isFinite(Date.parse(attempt.retryAfter))
      )
    ) ||
    ![undefined, null, true, false].includes(attempt.restartVerified)
  ) {
    fail(
      "COLLABORATION_OUTCOME_ATTEMPT_INVALID",
      "Collaboration outcome requires a valid route-bound transport result.",
    );
  }
}

function validateRun(owner, run) {
  if (
    run?.schemaVersion !== 1 ||
    run.protocolVersion !== 1 ||
    !validText(run.runId) ||
    !Number.isSafeInteger(run.eventCount) ||
    run.eventCount < 1 ||
    !validText(run.phase)
  ) {
    fail(
      "COLLABORATION_OUTCOME_RUN_INVALID",
      "Collaboration outcome run state is malformed or unsupported.",
    );
  }
  const route = run.routing;
  const outboundRoute = run.outbound?.routing;
  if (
    !route ||
    route.workspaceId !== owner.workspaceId ||
    route.coordinatorId !== owner.coordinatorId ||
    route.workUnitId !== owner.workUnitId ||
    (
      outboundRoute &&
      (
        outboundRoute.workspaceId !== owner.workspaceId ||
        outboundRoute.coordinatorId !== owner.coordinatorId ||
        outboundRoute.workUnitId !== owner.workUnitId ||
        outboundRoute.agentId !== owner.agentId
      )
    )
  ) {
    fail(
      "COLLABORATION_OUTCOME_ROUTE_MISMATCH",
      "Transport attempt and run do not share one immutable coordinator route.",
    );
  }
}

function noRunAuthority(attempt) {
  if (attempt.phase === "ready") {
    return {
      classification: "transport_ready_no_run",
      authority: {
        capsulePreparation: "authorized",
        sourceEgress: "not_reserved",
        externalTurn: "not_started",
        externalClaims: "none",
        localEvidence: "independent_only",
      },
    };
  }
  return {
    classification: attempt.phase === "stopped"
      ? "transport_stopped_pre_egress"
      : "transport_pending_pre_egress",
    authority: {
      capsulePreparation: "denied",
      sourceEgress: "not_authorized",
      externalTurn: "not_started",
      externalClaims: "none",
      localEvidence: "independent_only",
    },
  };
}

function runAuthority(run) {
  const responseAvailable =
    run.collaboration?.responseBinding !== null &&
    run.collaboration?.responseBinding !== undefined;
  if (run.phase === "prepared") {
    return {
      classification: "capsule_prepared_not_sent",
      authority: {
        capsulePreparation: "already_prepared",
        sourceEgress: "not_reserved",
        externalTurn: "not_started",
        externalClaims: "none",
        localEvidence: "independent_only",
      },
    };
  }
  if (run.phase === "send_reserved") {
    return {
      classification: "send_reconciliation_required",
      authority: {
        capsulePreparation: "already_prepared",
        sourceEgress: "unknown",
        externalTurn: "reconciliation_required",
        externalClaims: "none",
        localEvidence: "independent_only",
      },
    };
  }
  if (
    run.phase === "send_confirmed" ||
    (run.phase === "response_pending_unknown" && run.outbound?.confirmed === true)
  ) {
    return {
      classification: "submitted_response_pending",
      authority: {
        capsulePreparation: "already_prepared",
        sourceEgress: "confirmed",
        externalTurn: "submitted",
        externalClaims: "not_available",
        localEvidence: "independent_only",
      },
    };
  }
  if (run.phase === "response_pending_unknown") {
    return {
      classification: "delivery_ambiguous",
      authority: {
        capsulePreparation: "already_prepared",
        sourceEgress: "unknown",
        externalTurn: "delivery_ambiguous",
        externalClaims: "none",
        localEvidence: "independent_only",
      },
    };
  }
  if (
    [
      "response_terminal",
      "reviewing",
      "validating",
      "needs_revision",
    ].includes(run.phase)
  ) {
    return {
      classification: "external_response_available",
      authority: {
        capsulePreparation: "already_prepared",
        sourceEgress: "confirmed",
        externalTurn: "response_received",
        externalClaims: "available_untrusted",
        localEvidence: "independent_only",
      },
    };
  }
  if (run.phase === "accepted") {
    return {
      classification: "collaboration_accepted",
      authority: {
        capsulePreparation: "already_prepared",
        sourceEgress: "confirmed",
        externalTurn: "response_received",
        externalClaims: "locally_accepted",
        localEvidence: "independent_only",
      },
    };
  }
  if (["blocked", "human_required"].includes(run.phase)) {
    const reserved = run.outbound !== null && run.outbound !== undefined;
    const submitted = run.outbound?.confirmed === true;
    return {
      classification: run.phase === "blocked"
        ? "collaboration_blocked"
        : "human_action_required",
      authority: {
        capsulePreparation: "already_prepared",
        sourceEgress: submitted
          ? "confirmed"
          : reserved
            ? "unknown"
            : "not_reserved",
        externalTurn: responseAvailable
          ? "response_received"
          : submitted
            ? "submitted"
            : reserved
              ? "reconciliation_required"
              : "not_started",
        externalClaims: responseAvailable ? "available_untrusted" : "none",
        localEvidence: "independent_only",
      },
    };
  }
  fail(
    "COLLABORATION_OUTCOME_RUN_INVALID",
    `Collaboration outcome does not support run phase ${run.phase}.`,
  );
}

function statementFor({ classification, attempt, authority }) {
  const retry = attempt.retryAfter === undefined || attempt.retryAfter === null
    ? ""
    : `; retryAfter=${attempt.retryAfter}`;
  return "External collaborator outcome: " +
    `${classification}; adapter=${attempt.adapter ?? "none"}; ` +
    `reason=${attempt.reason}${retry}; ` +
    `capsulePreparation=${authority.capsulePreparation}; ` +
    `sourceEgress=${authority.sourceEgress}; ` +
    `externalTurn=${authority.externalTurn}; ` +
    `externalClaims=${authority.externalClaims}. ` +
    "Any local browser, Playwright, repository, or staging evidence is " +
    "independent Codex evidence, not an external-collaborator transport fallback.";
}

export function buildCollaborationOutcome({ owner, attempt, run = null }) {
  validateOwner(owner);
  validateAttempt(owner, attempt);
  if (run !== null) {
    validateRun(owner, run);
    if (attempt.phase !== "ready" || attempt.decision !== "ready") {
      fail(
        "COLLABORATION_OUTCOME_BINDING_INVALID",
        "A collaboration run requires the route's ready transport attempt.",
      );
    }
  }
  const assessment = run === null
    ? noRunAuthority(attempt)
    : runAuthority(run);
  const attemptView = {
    attemptId: attempt.attemptId,
    sequence: attempt.sequence,
    phase: attempt.phase,
    decision: attempt.decision,
    adapter: attempt.adapter,
    reason: attempt.reason,
    ...(attempt.retryAfter === undefined
      ? {}
      : { retryAfter: attempt.retryAfter }),
    ...(attempt.restartVerified === undefined
      ? {}
      : { restartVerified: attempt.restartVerified }),
    nextAction: attempt.nextAction,
  };
  const runView = run === null
    ? null
    : {
        runId: run.runId,
        eventSequence: run.eventCount,
        phase: run.phase,
        sendConfirmed: run.outbound?.confirmed === true,
      };
  return {
    schema: RESULT_SCHEMA,
    classification: assessment.classification,
    attempt: attemptView,
    run: runView,
    authority: assessment.authority,
    statement: statementFor({
      classification: assessment.classification,
      attempt: attemptView,
      authority: assessment.authority,
    }),
  };
}
