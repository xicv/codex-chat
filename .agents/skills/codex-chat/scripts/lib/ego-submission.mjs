import { createHash } from "node:crypto";
import { fail } from "./errors.mjs";
import { LIMITS_TRANSPORT_MANIFEST_V1 } from "./limits.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const PROVIDER_ORIGIN = "https://chatgpt.com";
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const MAX_COMPOSER_BYTES =
  LIMITS_TRANSPORT_MANIFEST_V1.maxInlineComposerBytes;
const MAX_ATTACHMENT_BYTES = LIMITS_TRANSPORT_MANIFEST_V1.maxContextBytes;
const BINDING_KEYS = Object.freeze(["taskSpaceId", "targetId"]);
const COMPOSE_KEYS = Object.freeze(["binding", "plan", "observation"]);
const COMPOSE_PLAN_KEYS = Object.freeze([
  "composerBytes",
  "composerSha256",
]);
const PAGE_KEYS = Object.freeze([
  "taskSpaceId",
  "targetIds",
  "selectedTargetId",
  "providerOrigin",
]);
const COMPOSE_OBSERVATION_KEYS = Object.freeze([
  ...PAGE_KEYS,
  "composerState",
  "composerBytes",
  "composerSha256",
]);
const SUBMIT_PLAN_KEYS = Object.freeze([
  ...COMPOSE_PLAN_KEYS,
  "outboundMarkerSha256",
  "sendLocator",
  "attachmentRequired",
  "attachmentOrdinal",
  "attachmentBytes",
  "attachmentSha256",
]);
const SUBMIT_OBSERVATION_KEYS = Object.freeze([
  ...COMPOSE_OBSERVATION_KEYS,
  "composerMarkerOccurrences",
  "submittedMarkerOccurrences",
  "enabledSendLocators",
  "attachmentState",
  "attachmentOrdinal",
  "attachmentBytes",
  "attachmentSha256",
]);
const POST_SUBMIT_KEYS = Object.freeze(["binding", "observation"]);
const POST_SUBMIT_OBSERVATION_KEYS = Object.freeze([
  ...PAGE_KEYS,
  "clickOutcome",
  "submittedMarkerOccurrences",
  "locatorState",
  "providerLocator",
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

function validCount(value, maximum = 64) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function validBinding(binding) {
  return exactKeys(binding, BINDING_KEYS) &&
    validCount(binding.taskSpaceId, Number.MAX_SAFE_INTEGER) &&
    validText(binding.targetId, 512);
}

function validPageObservation(observation) {
  return validCount(observation?.taskSpaceId, Number.MAX_SAFE_INTEGER) &&
    Array.isArray(observation?.targetIds) &&
    observation.targetIds.length >= 1 &&
    observation.targetIds.length <= 64 &&
    observation.targetIds.every((targetId) => validText(targetId, 512)) &&
    new Set(observation.targetIds).size === observation.targetIds.length &&
    validText(observation.selectedTargetId, 512) &&
    observation.targetIds.includes(observation.selectedTargetId) &&
    validText(observation.providerOrigin, 256);
}

function validComposerObservation(observation) {
  if (!["empty", "nonempty", "unsupported"].includes(
    observation?.composerState,
  )) {
    return false;
  }
  if (observation.composerState === "unsupported") {
    return observation.composerBytes === null &&
      observation.composerSha256 === null;
  }
  if (
    !validCount(observation.composerBytes, MAX_COMPOSER_BYTES) ||
    !SHA256.test(observation.composerSha256 ?? "")
  ) {
    return false;
  }
  return observation.composerState === "empty"
    ? observation.composerBytes === 0 &&
      observation.composerSha256 === EMPTY_SHA256
    : observation.composerBytes > 0;
}

function validComposerPlan(plan) {
  return exactKeys(plan, COMPOSE_PLAN_KEYS) &&
    validCount(plan.composerBytes, MAX_COMPOSER_BYTES) &&
    plan.composerBytes > 0 &&
    SHA256.test(plan.composerSha256 ?? "");
}

function bindingStatus(binding, observation) {
  const providerValid = observation.providerOrigin === PROVIDER_ORIGIN;
  const targetValid = observation.taskSpaceId === binding.taskSpaceId &&
    observation.selectedTargetId === binding.targetId &&
    observation.targetIds.includes(binding.targetId);
  return {
    confirmed: providerValid && targetValid,
    failureReason: !providerValid
      ? "provider_origin_invalid"
      : targetValid
      ? null
      : "binding_changed",
  };
}

function composeResult(
  decision,
  failureReason,
  bindingConfirmed,
  plan,
) {
  return {
    decision,
    failureReason,
    bindingConfirmed,
    safeToType: decision === "type_planned",
    safeToReuse: decision === "reuse_exact",
    composerBytes: plan.composerBytes,
    composerSha256: plan.composerSha256,
    actionAuthorized: false,
  };
}

export function decideEgoCompose(input) {
  const observation = input?.observation;
  if (
    !exactKeys(input, COMPOSE_KEYS) ||
    !validBinding(input.binding) ||
    !validComposerPlan(input.plan) ||
    !exactKeys(observation, COMPOSE_OBSERVATION_KEYS) ||
    !validPageObservation(observation) ||
    !validComposerObservation(observation)
  ) {
    fail(
      "EGO_COMPOSE_INPUT_INVALID",
      "Ego compose input is malformed or contains unsupported fields.",
    );
  }
  const binding = bindingStatus(input.binding, observation);
  if (!binding.confirmed) {
    return composeResult("stop", binding.failureReason, false, input.plan);
  }
  if (observation.composerState === "unsupported") {
    return composeResult("stop", "composer_unsupported", true, input.plan);
  }
  if (observation.composerState === "empty") {
    return composeResult("type_planned", null, true, input.plan);
  }
  if (
    observation.composerBytes === input.plan.composerBytes &&
    observation.composerSha256 === input.plan.composerSha256
  ) {
    return composeResult("reuse_exact", null, true, input.plan);
  }
  return composeResult("stop", "composer_diverged", true, input.plan);
}

function validSubmitPlan(plan) {
  return exactKeys(plan, SUBMIT_PLAN_KEYS) &&
    validCount(plan.composerBytes, MAX_COMPOSER_BYTES) &&
    plan.composerBytes > 0 &&
    SHA256.test(plan.composerSha256 ?? "") &&
    SHA256.test(plan.outboundMarkerSha256 ?? "") &&
    validText(plan.sendLocator, 2048) &&
    typeof plan.attachmentRequired === "boolean" &&
    (
      plan.attachmentRequired
        ? validAttachmentMetadata(plan)
        : emptyAttachmentMetadata(plan)
    );
}

function emptyAttachmentMetadata(value) {
  return value.attachmentOrdinal === null &&
    value.attachmentBytes === null &&
    value.attachmentSha256 === null;
}

function validAttachmentMetadata(value) {
  return value.attachmentOrdinal === 0 &&
    validCount(value.attachmentBytes, MAX_ATTACHMENT_BYTES) &&
    value.attachmentBytes > 0 &&
    SHA256.test(value.attachmentSha256 ?? "");
}

function submitResult(
  decision,
  failureReason,
  bindingConfirmed,
  plan,
) {
  return {
    decision,
    failureReason,
    bindingConfirmed,
    safeToClick: decision === "submit_once",
    sendLocator: decision === "submit_once" ? plan.sendLocator : null,
    outboundMarkerSha256: plan.outboundMarkerSha256,
    actionAuthorized: false,
    resendAuthorized: false,
  };
}

export function decideEgoPreSubmit(input) {
  const observation = input?.observation;
  if (
    !exactKeys(input, COMPOSE_KEYS) ||
    !validBinding(input.binding) ||
    !validSubmitPlan(input.plan) ||
    !exactKeys(observation, SUBMIT_OBSERVATION_KEYS) ||
    !validPageObservation(observation) ||
    !validComposerObservation(observation) ||
    !validCount(observation.composerMarkerOccurrences) ||
    !validCount(observation.submittedMarkerOccurrences) ||
    !Array.isArray(observation.enabledSendLocators) ||
    observation.enabledSendLocators.length > 64 ||
    observation.enabledSendLocators.some((locator) => !validText(locator, 2048)) ||
    new Set(observation.enabledSendLocators).size !==
      observation.enabledSendLocators.length ||
    !["accepted", "not_required", "missing", "ambiguous"].includes(
      observation.attachmentState,
    ) ||
    !(
      emptyAttachmentMetadata(observation) ||
      validAttachmentMetadata(observation)
    )
  ) {
    fail(
      "EGO_PRE_SUBMIT_INPUT_INVALID",
      "Ego pre-submit input is malformed or contains unsupported fields.",
    );
  }
  const binding = bindingStatus(input.binding, observation);
  if (!binding.confirmed) {
    return submitResult("stop", binding.failureReason, false, input.plan);
  }
  if (
    observation.composerState !== "nonempty" ||
    observation.composerBytes !== input.plan.composerBytes ||
    observation.composerSha256 !== input.plan.composerSha256
  ) {
    return submitResult("stop", "composer_diverged", true, input.plan);
  }
  if (observation.composerMarkerOccurrences !== 1) {
    return submitResult("stop", "composer_marker_invalid", true, input.plan);
  }
  if (observation.submittedMarkerOccurrences !== 0) {
    return submitResult("stop", "marker_already_submitted", true, input.plan);
  }
  const attachmentReady = input.plan.attachmentRequired
    ? observation.attachmentState === "accepted" &&
      observation.attachmentOrdinal === input.plan.attachmentOrdinal &&
      observation.attachmentBytes === input.plan.attachmentBytes &&
      observation.attachmentSha256 === input.plan.attachmentSha256
    : observation.attachmentState === "not_required" &&
      emptyAttachmentMetadata(observation);
  if (!attachmentReady) {
    return submitResult("stop", "attachment_not_accepted", true, input.plan);
  }
  if (
    observation.enabledSendLocators.length !== 1 ||
    observation.enabledSendLocators[0] !== input.plan.sendLocator
  ) {
    return submitResult("stop", "send_control_changed", true, input.plan);
  }
  return submitResult("submit_once", null, true, input.plan);
}

function validPostSubmitObservation(observation) {
  const locatorValid = observation?.providerLocator === null ||
    validText(observation.providerLocator, 2048);
  const locatorShapeValid = observation?.locatorState === "unobserved"
    ? observation.providerLocator === null
    : locatorValid && observation.providerLocator !== null;
  const stableLocatorValid = observation?.locatorState !== "stable" ||
    (
      typeof observation.providerLocator === "string" &&
      !observation.providerLocator.startsWith("/c/WEB:")
    );
  return exactKeys(observation, POST_SUBMIT_OBSERVATION_KEYS) &&
    validPageObservation(observation) &&
    ["confirmed_invoked", "provably_not_invoked", "unknown"].includes(
      observation.clickOutcome,
    ) &&
    (
      observation.submittedMarkerOccurrences === null ||
      validCount(observation.submittedMarkerOccurrences)
    ) &&
    ["stable", "provisional", "unobserved"].includes(
      observation.locatorState,
    ) &&
    locatorShapeValid &&
    stableLocatorValid;
}

function postSubmitResult(
  deliveryClassification,
  failureReason,
  bindingConfirmed,
  observation,
) {
  return {
    deliveryClassification,
    failureReason,
    bindingConfirmed,
    providerLocator: deliveryClassification === "accepted"
      ? observation.providerLocator
      : null,
    submittedMarkerOccurrences: observation.submittedMarkerOccurrences,
    resendAuthorized: false,
  };
}

export function classifyEgoPostSubmit(input) {
  const observation = input?.observation;
  if (
    !exactKeys(input, POST_SUBMIT_KEYS) ||
    !validBinding(input.binding) ||
    !validPostSubmitObservation(observation)
  ) {
    fail(
      "EGO_POST_SUBMIT_INPUT_INVALID",
      "Ego post-submit input is malformed or contains unsupported fields.",
    );
  }
  const binding = bindingStatus(input.binding, observation);
  if (!binding.confirmed) {
    return postSubmitResult(
      "ambiguous",
      binding.failureReason,
      false,
      observation,
    );
  }
  if (
    observation.submittedMarkerOccurrences === 1 &&
    observation.clickOutcome !== "provably_not_invoked" &&
    observation.locatorState === "stable"
  ) {
    return postSubmitResult("accepted", null, true, observation);
  }
  if (
    observation.submittedMarkerOccurrences === 0 &&
    observation.clickOutcome === "provably_not_invoked" &&
    observation.locatorState === "unobserved"
  ) {
    return postSubmitResult(
      "absent",
      "submit_provably_not_invoked",
      true,
      observation,
    );
  }
  return postSubmitResult(
    "ambiguous",
    "delivery_ambiguous",
    true,
    observation,
  );
}
