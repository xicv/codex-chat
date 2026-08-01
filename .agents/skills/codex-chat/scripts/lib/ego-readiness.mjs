import { fail } from "./errors.mjs";

const INPUT_KEYS = Object.freeze([
  "stage",
  "initialTargetId",
  "candidateTargetId",
  "preservedDraftTargetId",
  "observation",
]);
const OBSERVATION_KEYS = Object.freeze([
  "providerOrigin",
  "providerPath",
  "pageReady",
  "composerReady",
  "composerState",
  "loginControlPresent",
  "accountUiPresent",
  "challengePresent",
]);
const CLEANUP_KEYS = Object.freeze([
  "targetIds",
  "boundTargetId",
  "preservedDraftTargetId",
]);

function exactKeys(value, keys) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
}

function validText(value, maxLength) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateInput(input) {
  const observation = input?.observation;
  if (
    !exactKeys(input, INPUT_KEYS) ||
    !["initial", "fresh"].includes(input.stage) ||
    !validText(input.initialTargetId, 512) ||
    !validText(input.candidateTargetId, 512) ||
    !(
      input.preservedDraftTargetId === null ||
      validText(input.preservedDraftTargetId, 512)
    ) ||
    (
      input.stage === "initial" &&
      (
        input.candidateTargetId !== input.initialTargetId ||
        input.preservedDraftTargetId !== null
      )
    ) ||
    (
      input.stage === "fresh" &&
      input.preservedDraftTargetId !== input.initialTargetId
    ) ||
    !exactKeys(observation, OBSERVATION_KEYS) ||
    !validText(observation.providerOrigin, 256) ||
    !validText(observation.providerPath, 2048) ||
    !["empty", "nonempty", "unsupported"].includes(
      observation.composerState,
    ) ||
    [
      "pageReady",
      "composerReady",
      "loginControlPresent",
      "accountUiPresent",
      "challengePresent",
    ].some((key) => typeof observation[key] !== "boolean")
  ) {
    fail(
      "EGO_READINESS_INPUT_INVALID",
      "Ego readiness input is malformed or contains unsupported fields.",
    );
  }
  return input;
}

function validateCleanupInput(input) {
  if (
    !exactKeys(input, CLEANUP_KEYS) ||
    !Array.isArray(input.targetIds) ||
    input.targetIds.length < 1 ||
    input.targetIds.length > 64 ||
    input.targetIds.some((targetId) => !validText(targetId, 512)) ||
    new Set(input.targetIds).size !== input.targetIds.length ||
    !validText(input.boundTargetId, 512) ||
    !(
      input.preservedDraftTargetId === null ||
      validText(input.preservedDraftTargetId, 512)
    )
  ) {
    fail(
      "EGO_CLEANUP_INPUT_INVALID",
      "Ego cleanup input is malformed or contains unsupported fields.",
    );
  }
  return input;
}

function classifyReadiness({
  providerOriginInvalid,
  initialPageNotReady,
  freshTargetRequired,
  freshTargetReused,
  challengePresent,
  loginRequired,
  composerUnavailable,
  freshTargetUnready,
  composerUnsupported,
}) {
  if (providerOriginInvalid) {
    return { decision: "stop", failureReason: "provider_origin_invalid" };
  }
  if (initialPageNotReady) {
    return { decision: "stop", failureReason: "page_not_ready" };
  }
  if (freshTargetRequired) {
    return { decision: "fresh_target_required", failureReason: null };
  }
  if (freshTargetReused) {
    return { decision: "stop", failureReason: "fresh_target_not_distinct" };
  }
  if (challengePresent) {
    return {
      decision: "authentication_required",
      failureReason: "challenge_present",
    };
  }
  if (loginRequired) {
    return {
      decision: "authentication_required",
      failureReason: "login_required",
    };
  }
  if (composerUnavailable) {
    return { decision: "stop", failureReason: "composer_unavailable" };
  }
  if (freshTargetUnready) {
    return {
      decision: "stop",
      failureReason: "fresh_target_not_ready_and_empty",
    };
  }
  if (composerUnsupported) {
    return { decision: "stop", failureReason: "composer_unsupported" };
  }
  return { decision: "ready", failureReason: null };
}

export function decideEgoReadiness(input) {
  const {
    stage,
    initialTargetId,
    candidateTargetId,
    preservedDraftTargetId,
    observation,
  } = validateInput(input);
  const authenticated = observation.composerReady &&
    !observation.loginControlPresent &&
    !observation.challengePresent;
  const providerOriginInvalid = observation.providerOrigin !==
    "https://chatgpt.com";
  const initialPageNotReady = stage === "initial" && !observation.pageReady;
  const freshTargetRequired = stage === "initial" &&
    authenticated &&
    observation.composerState === "nonempty";
  const freshTargetReused = stage === "fresh" &&
    candidateTargetId === preservedDraftTargetId;
  const loginRequired = observation.loginControlPresent;
  const challengePresent = observation.challengePresent;
  const composerUnavailable = stage === "initial" &&
    !observation.composerReady;
  const composerUnsupported = observation.composerState === "unsupported";
  const freshTargetUnready = stage === "fresh" && (
    !observation.pageReady ||
    !observation.composerReady ||
    observation.composerState !== "empty"
  );
  const classification = classifyReadiness({
    providerOriginInvalid,
    initialPageNotReady,
    freshTargetRequired,
    freshTargetReused,
    challengePresent,
    loginRequired,
    composerUnavailable,
    freshTargetUnready,
    composerUnsupported,
  });
  const ready = classification.decision === "ready";
  return {
    decision: classification.decision,
    ready,
    failureReason: classification.failureReason,
    targetId: ready ? candidateTargetId : null,
    candidateTargetId,
    preservedDraftTargetId: freshTargetRequired
      ? initialTargetId
      : preservedDraftTargetId,
    providerOrigin: observation.providerOrigin,
    providerPath: observation.providerPath,
    pageReady: observation.pageReady,
    composerReady: observation.composerReady,
    composerState: observation.composerState,
    accountUiPresent: observation.accountUiPresent,
    authenticated,
    challengePresent: observation.challengePresent,
  };
}

export function planEgoCleanup(input) {
  const {
    targetIds,
    boundTargetId,
    preservedDraftTargetId,
  } = validateCleanupInput(input);
  if (preservedDraftTargetId === null) {
    if (
      targetIds.length !== 1 ||
      targetIds[0] !== boundTargetId
    ) {
      return {
        safe: false,
        failureReason: "cleanup_targets_changed",
        closeTargetIds: [],
        preserveTargetIds: [...targetIds],
        keepTaskSpace: true,
      };
    }
    return {
      safe: true,
      failureReason: null,
      closeTargetIds: [],
      preserveTargetIds: [],
      keepTaskSpace: false,
    };
  }
  if (boundTargetId === preservedDraftTargetId) {
    return {
      safe: false,
      failureReason: "cleanup_targets_not_distinct",
      closeTargetIds: [],
      preserveTargetIds: [preservedDraftTargetId],
      keepTaskSpace: true,
    };
  }
  if (
    !targetIds.includes(boundTargetId) ||
    !targetIds.includes(preservedDraftTargetId)
  ) {
    return {
      safe: false,
      failureReason: "cleanup_targets_changed",
      closeTargetIds: [],
      preserveTargetIds: [preservedDraftTargetId],
      keepTaskSpace: true,
    };
  }
  return {
    safe: true,
    failureReason: null,
    closeTargetIds: [boundTargetId],
    preserveTargetIds: [preservedDraftTargetId],
    keepTaskSpace: true,
  };
}
