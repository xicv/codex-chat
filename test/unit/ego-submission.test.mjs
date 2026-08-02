import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  classifyEgoPostSubmit,
  decideEgoCompose,
  decideEgoPreSubmit,
} from "../../.agents/skills/codex-chat/scripts/lib/ego-submission.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const EMPTY_SHA256 = sha256("");
const COMPOSER = "Review the capsule.\nCODEX_CHAT_OUTBOUND marker-1\n";
const COMPOSER_SHA256 = sha256(COMPOSER);
const MARKER_SHA256 = sha256("CODEX_CHAT_OUTBOUND marker-1");

const BINDING = Object.freeze({
  taskSpaceId: 7,
  targetId: "target-collaborator",
});
const COMPOSE_PLAN = Object.freeze({
  composerBytes: Buffer.byteLength(COMPOSER),
  composerSha256: COMPOSER_SHA256,
});
const BOUND_PAGE = Object.freeze({
  taskSpaceId: 7,
  targetIds: ["target-collaborator"],
  selectedTargetId: "target-collaborator",
  providerOrigin: "https://chatgpt.com",
});

test("an empty bound composer permits only the planned type action", () => {
  const result = decideEgoCompose({
    binding: BINDING,
    plan: COMPOSE_PLAN,
    observation: {
      ...BOUND_PAGE,
      composerState: "empty",
      composerBytes: 0,
      composerSha256: EMPTY_SHA256,
    },
  });

  assert.deepEqual(result, {
    decision: "type_planned",
    failureReason: null,
    bindingConfirmed: true,
    safeToType: true,
    safeToReuse: false,
    composerBytes: COMPOSE_PLAN.composerBytes,
    composerSha256: COMPOSE_PLAN.composerSha256,
    actionAuthorized: false,
  });
});

test("an exact existing composer is reused without typing", () => {
  const result = decideEgoCompose({
    binding: BINDING,
    plan: COMPOSE_PLAN,
    observation: {
      ...BOUND_PAGE,
      composerState: "nonempty",
      composerBytes: COMPOSE_PLAN.composerBytes,
      composerSha256: COMPOSE_PLAN.composerSha256,
    },
  });

  assert.equal(result.decision, "reuse_exact");
  assert.equal(result.safeToType, false);
  assert.equal(result.safeToReuse, true);
  assert.equal(result.actionAuthorized, false);
});

test("unknown drafts and unsupported composer shapes stop without mutation", () => {
  const divergent = decideEgoCompose({
    binding: BINDING,
    plan: COMPOSE_PLAN,
    observation: {
      ...BOUND_PAGE,
      composerState: "nonempty",
      composerBytes: 17,
      composerSha256: sha256("unrelated draft\n"),
    },
  });
  const unsupported = decideEgoCompose({
    binding: BINDING,
    plan: COMPOSE_PLAN,
    observation: {
      ...BOUND_PAGE,
      composerState: "unsupported",
      composerBytes: null,
      composerSha256: null,
    },
  });

  assert.equal(divergent.decision, "stop");
  assert.equal(divergent.failureReason, "composer_diverged");
  assert.equal(divergent.safeToType, false);
  assert.equal(unsupported.decision, "stop");
  assert.equal(unsupported.failureReason, "composer_unsupported");
});

test("crossed task-space, target, or provider bindings stop composition", () => {
  const cases = [
    { taskSpaceId: 8 },
    { selectedTargetId: "target-other", targetIds: ["target-other"] },
    { providerOrigin: "https://example.com" },
  ];

  for (const changed of cases) {
    const result = decideEgoCompose({
      binding: BINDING,
      plan: COMPOSE_PLAN,
      observation: {
        ...BOUND_PAGE,
        composerState: "empty",
        composerBytes: 0,
        composerSha256: EMPTY_SHA256,
        ...changed,
      },
    });
    assert.equal(result.decision, "stop");
    assert.equal(result.safeToType, false);
    assert.equal(result.bindingConfirmed, false);
  }
});

const SUBMIT_PLAN = Object.freeze({
  ...COMPOSE_PLAN,
  outboundMarkerSha256: MARKER_SHA256,
  sendLocator: "send-button-1",
  attachmentRequired: true,
  attachmentOrdinal: 0,
  attachmentBytes: 65_536,
  attachmentSha256: sha256("context-attachment"),
});

const READY_TO_SUBMIT = Object.freeze({
  ...BOUND_PAGE,
  composerState: "nonempty",
  composerBytes: COMPOSE_PLAN.composerBytes,
  composerSha256: COMPOSE_PLAN.composerSha256,
  composerMarkerOccurrences: 1,
  submittedMarkerOccurrences: 0,
  enabledSendLocators: ["send-button-1"],
  attachmentState: "accepted",
  attachmentOrdinal: 0,
  attachmentBytes: 65_536,
  attachmentSha256: sha256("context-attachment"),
});

test("pre-submit permits one click only after every bound invariant holds", () => {
  const result = decideEgoPreSubmit({
    binding: BINDING,
    plan: SUBMIT_PLAN,
    observation: READY_TO_SUBMIT,
  });

  assert.deepEqual(result, {
    decision: "submit_once",
    failureReason: null,
    bindingConfirmed: true,
    safeToClick: true,
    sendLocator: "send-button-1",
    outboundMarkerSha256: MARKER_SHA256,
    actionAuthorized: false,
    resendAuthorized: false,
  });
});

test("pre-submit stops on attachment, marker, composer, or locator ambiguity", () => {
  const cases = [
    [{ attachmentState: "ambiguous" }, "attachment_not_accepted"],
    [{ attachmentSha256: sha256("wrong-attachment") }, "attachment_not_accepted"],
    [{ composerMarkerOccurrences: 2 }, "composer_marker_invalid"],
    [{ submittedMarkerOccurrences: 1 }, "marker_already_submitted"],
    [{ composerSha256: sha256("changed") }, "composer_diverged"],
    [{ enabledSendLocators: ["send-button-2"] }, "send_control_changed"],
    [{ enabledSendLocators: ["send-button-1", "send-button-2"] }, "send_control_changed"],
  ];

  for (const [changed, failureReason] of cases) {
    const result = decideEgoPreSubmit({
      binding: BINDING,
      plan: SUBMIT_PLAN,
      observation: { ...READY_TO_SUBMIT, ...changed },
    });
    assert.equal(result.decision, "stop");
    assert.equal(result.failureReason, failureReason);
    assert.equal(result.safeToClick, false);
    assert.equal(result.resendAuthorized, false);
  }
});

test("inline transport requires an explicit not-required attachment observation", () => {
  const result = decideEgoPreSubmit({
    binding: BINDING,
    plan: {
      ...SUBMIT_PLAN,
      attachmentRequired: false,
      attachmentOrdinal: null,
      attachmentBytes: null,
      attachmentSha256: null,
    },
    observation: {
      ...READY_TO_SUBMIT,
      attachmentState: "not_required",
      attachmentOrdinal: null,
      attachmentBytes: null,
      attachmentSha256: null,
    },
  });

  assert.equal(result.decision, "submit_once");
  assert.equal(result.safeToClick, true);
});

const POST_SUBMIT = Object.freeze({
  ...BOUND_PAGE,
  clickOutcome: "confirmed_invoked",
  submittedMarkerOccurrences: 1,
  locatorState: "stable",
  providerLocator: "/c/conversation-123",
});

test("one submitted marker plus a stable locator classifies accepted delivery", () => {
  const result = classifyEgoPostSubmit({
    binding: BINDING,
    observation: POST_SUBMIT,
  });

  assert.deepEqual(result, {
    deliveryClassification: "accepted",
    failureReason: null,
    bindingConfirmed: true,
    providerLocator: "/c/conversation-123",
    submittedMarkerOccurrences: 1,
    resendAuthorized: false,
  });
});

test("zero markers is absent only when the click provably did not run", () => {
  const absent = classifyEgoPostSubmit({
    binding: BINDING,
    observation: {
      ...POST_SUBMIT,
      clickOutcome: "provably_not_invoked",
      submittedMarkerOccurrences: 0,
      locatorState: "unobserved",
      providerLocator: null,
    },
  });
  const ambiguous = classifyEgoPostSubmit({
    binding: BINDING,
    observation: {
      ...POST_SUBMIT,
      clickOutcome: "unknown",
      submittedMarkerOccurrences: 0,
      locatorState: "unobserved",
      providerLocator: null,
    },
  });

  assert.equal(absent.deliveryClassification, "absent");
  assert.equal(absent.resendAuthorized, false);
  assert.equal(ambiguous.deliveryClassification, "ambiguous");
  assert.equal(ambiguous.resendAuthorized, false);
});

test("provisional locators, duplicate markers, and crossed bindings remain ambiguous", () => {
  const cases = [
    {
      locatorState: "provisional",
      providerLocator: "/c/WEB:temporary",
    },
    { submittedMarkerOccurrences: 2 },
    { selectedTargetId: "target-other", targetIds: ["target-other"] },
  ];

  for (const changed of cases) {
    const result = classifyEgoPostSubmit({
      binding: BINDING,
      observation: { ...POST_SUBMIT, ...changed },
    });
    assert.equal(result.deliveryClassification, "ambiguous");
    assert.equal(result.resendAuthorized, false);
  }
});

test("submission decisions reject raw draft bytes and unknown fields", () => {
  assert.throws(
    () => decideEgoCompose({
      binding: BINDING,
      plan: COMPOSE_PLAN,
      observation: {
        ...BOUND_PAGE,
        composerState: "empty",
        composerBytes: 0,
        composerSha256: EMPTY_SHA256,
        draftText: "do not leak me",
      },
    }),
    { code: "EGO_COMPOSE_INPUT_INVALID" },
  );
  assert.throws(
    () => classifyEgoPostSubmit({
      binding: BINDING,
      observation: { ...POST_SUBMIT, responseText: "untrusted" },
    }),
    { code: "EGO_POST_SUBMIT_INPUT_INVALID" },
  );
  assert.throws(
    () => classifyEgoPostSubmit({
      binding: BINDING,
      observation: {
        ...POST_SUBMIT,
        providerLocator: null,
      },
    }),
    { code: "EGO_POST_SUBMIT_INPUT_INVALID" },
  );
  assert.throws(
    () => decideEgoPreSubmit({
      binding: BINDING,
      plan: { ...SUBMIT_PLAN, attachmentOrdinal: 1 },
      observation: { ...READY_TO_SUBMIT, attachmentOrdinal: 1 },
    }),
    { code: "EGO_PRE_SUBMIT_INPUT_INVALID" },
  );
});
