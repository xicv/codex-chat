import assert from "node:assert/strict";
import test from "node:test";
import {
  decideEgoReadiness,
  planEgoCleanup,
} from "../../.agents/skills/codex-chat/scripts/lib/ego-readiness.mjs";

const EMPTY_OBSERVATION = Object.freeze({
  providerOrigin: "https://chatgpt.com",
  providerPath: "/",
  pageReady: true,
  composerReady: true,
  composerState: "empty",
  loginControlPresent: false,
  accountUiPresent: false,
  challengePresent: false,
});

test("an authenticated empty initial composer binds its exact target", () => {
  const result = decideEgoReadiness({
    stage: "initial",
    initialTargetId: "target-initial",
    candidateTargetId: "target-initial",
    preservedDraftTargetId: null,
    observation: EMPTY_OBSERVATION,
  });

  assert.deepEqual(result, {
    decision: "ready",
    ready: true,
    failureReason: null,
    targetId: "target-initial",
    candidateTargetId: "target-initial",
    preservedDraftTargetId: null,
    providerOrigin: "https://chatgpt.com",
    providerPath: "/",
    pageReady: true,
    composerReady: true,
    composerState: "empty",
    accountUiPresent: false,
    authenticated: true,
    challengePresent: false,
  });
});

test("a nonempty initial composer preserves its target and requests one fresh target", () => {
  const result = decideEgoReadiness({
    stage: "initial",
    initialTargetId: "target-draft",
    candidateTargetId: "target-draft",
    preservedDraftTargetId: null,
    observation: {
      ...EMPTY_OBSERVATION,
      composerState: "nonempty",
    },
  });

  assert.equal(result.decision, "fresh_target_required");
  assert.equal(result.ready, false);
  assert.equal(result.failureReason, null);
  assert.equal(result.targetId, null);
  assert.equal(result.candidateTargetId, "target-draft");
  assert.equal(result.preservedDraftTargetId, "target-draft");
  assert.equal(result.authenticated, true);
});

test("a fresh-stage observation cannot reuse the preserved draft target", () => {
  const result = decideEgoReadiness({
    stage: "fresh",
    initialTargetId: "target-draft",
    candidateTargetId: "target-draft",
    preservedDraftTargetId: "target-draft",
    observation: EMPTY_OBSERVATION,
  });

  assert.equal(result.decision, "stop");
  assert.equal(result.ready, false);
  assert.equal(result.failureReason, "fresh_target_not_distinct");
  assert.equal(result.targetId, null);
  assert.equal(result.preservedDraftTargetId, "target-draft");
});

test("a visible login control requires user authentication instead of readiness", () => {
  const result = decideEgoReadiness({
    stage: "initial",
    initialTargetId: "target-login",
    candidateTargetId: "target-login",
    preservedDraftTargetId: null,
    observation: {
      ...EMPTY_OBSERVATION,
      composerReady: false,
      composerState: "unsupported",
      loginControlPresent: true,
    },
  });

  assert.equal(result.decision, "authentication_required");
  assert.equal(result.ready, false);
  assert.equal(result.failureReason, "login_required");
  assert.equal(result.targetId, null);
  assert.equal(result.authenticated, false);
});

test("a verification challenge requires user control and cannot be ready", () => {
  const result = decideEgoReadiness({
    stage: "initial",
    initialTargetId: "target-challenge",
    candidateTargetId: "target-challenge",
    preservedDraftTargetId: null,
    observation: {
      ...EMPTY_OBSERVATION,
      challengePresent: true,
    },
  });

  assert.equal(result.decision, "authentication_required");
  assert.equal(result.ready, false);
  assert.equal(result.failureReason, "challenge_present");
  assert.equal(result.targetId, null);
  assert.equal(result.authenticated, false);
});

test("unsupported composer DOM stops instead of binding an authenticated page", () => {
  const result = decideEgoReadiness({
    stage: "initial",
    initialTargetId: "target-unsupported",
    candidateTargetId: "target-unsupported",
    preservedDraftTargetId: null,
    observation: {
      ...EMPTY_OBSERVATION,
      composerState: "unsupported",
    },
  });

  assert.equal(result.decision, "stop");
  assert.equal(result.ready, false);
  assert.equal(result.failureReason, "composer_unsupported");
  assert.equal(result.targetId, null);
});

test("a distinct fresh target must still be ready and empty", () => {
  const result = decideEgoReadiness({
    stage: "fresh",
    initialTargetId: "target-draft",
    candidateTargetId: "target-fresh",
    preservedDraftTargetId: "target-draft",
    observation: {
      ...EMPTY_OBSERVATION,
      composerState: "nonempty",
    },
  });

  assert.equal(result.decision, "stop");
  assert.equal(result.ready, false);
  assert.equal(result.failureReason, "fresh_target_not_ready_and_empty");
  assert.equal(result.targetId, null);
  assert.equal(result.preservedDraftTargetId, "target-draft");
});

test("a distinct ready empty fresh target becomes the binding while preserving the draft", () => {
  const result = decideEgoReadiness({
    stage: "fresh",
    initialTargetId: "target-draft",
    candidateTargetId: "target-fresh",
    preservedDraftTargetId: "target-draft",
    observation: EMPTY_OBSERVATION,
  });

  assert.equal(result.decision, "ready");
  assert.equal(result.ready, true);
  assert.equal(result.targetId, "target-fresh");
  assert.equal(result.preservedDraftTargetId, "target-draft");
});

test("the readiness interface rejects draft bytes and unexpected observation fields", () => {
  assert.throws(
    () => decideEgoReadiness({
      stage: "initial",
      initialTargetId: "target-unsafe",
      candidateTargetId: "target-unsafe",
      preservedDraftTargetId: null,
      observation: {
        ...EMPTY_OBSERVATION,
        draftText: "sign in to finish this unrelated draft",
      },
    }),
    { code: "EGO_READINESS_INPUT_INVALID" },
  );
});

test("readiness stages reject crossed initial and preserved target identities", () => {
  assert.throws(
    () => decideEgoReadiness({
      stage: "initial",
      initialTargetId: "target-initial",
      candidateTargetId: "target-other",
      preservedDraftTargetId: null,
      observation: EMPTY_OBSERVATION,
    }),
    { code: "EGO_READINESS_INPUT_INVALID" },
  );
  assert.throws(
    () => decideEgoReadiness({
      stage: "fresh",
      initialTargetId: "target-draft",
      candidateTargetId: "target-fresh",
      preservedDraftTargetId: null,
      observation: EMPTY_OBSERVATION,
    }),
    { code: "EGO_READINESS_INPUT_INVALID" },
  );
});

test("a readiness observation from another origin cannot bind a target", () => {
  const result = decideEgoReadiness({
    stage: "initial",
    initialTargetId: "target-origin",
    candidateTargetId: "target-origin",
    preservedDraftTargetId: null,
    observation: {
      ...EMPTY_OBSERVATION,
      providerOrigin: "https://example.com",
    },
  });

  assert.equal(result.decision, "stop");
  assert.equal(result.ready, false);
  assert.equal(result.failureReason, "provider_origin_invalid");
  assert.equal(result.targetId, null);
});

test("an empty composer on an unready page cannot bind a target", () => {
  const result = decideEgoReadiness({
    stage: "initial",
    initialTargetId: "target-loading",
    candidateTargetId: "target-loading",
    preservedDraftTargetId: null,
    observation: {
      ...EMPTY_OBSERVATION,
      pageReady: false,
    },
  });

  assert.equal(result.decision, "stop");
  assert.equal(result.ready, false);
  assert.equal(result.failureReason, "page_not_ready");
  assert.equal(result.targetId, null);
});

test("a missing initial composer cannot bind even when its state is reported empty", () => {
  const result = decideEgoReadiness({
    stage: "initial",
    initialTargetId: "target-no-composer",
    candidateTargetId: "target-no-composer",
    preservedDraftTargetId: null,
    observation: {
      ...EMPTY_OBSERVATION,
      composerReady: false,
    },
  });

  assert.equal(result.decision, "stop");
  assert.equal(result.ready, false);
  assert.equal(result.failureReason, "composer_unavailable");
  assert.equal(result.targetId, null);
  assert.equal(result.authenticated, false);
});

test("every ready classification satisfies the complete readiness invariant", () => {
  const composerStates = ["empty", "nonempty", "unsupported"];
  const booleanValues = [false, true];

  for (const pageReady of booleanValues) {
    for (const composerReady of booleanValues) {
      for (const loginControlPresent of booleanValues) {
        for (const challengePresent of booleanValues) {
          for (const composerState of composerStates) {
            const result = decideEgoReadiness({
              stage: "initial",
              initialTargetId: "target-invariant",
              candidateTargetId: "target-invariant",
              preservedDraftTargetId: null,
              observation: {
                ...EMPTY_OBSERVATION,
                pageReady,
                composerReady,
                loginControlPresent,
                challengePresent,
                composerState,
              },
            });

            if (result.ready) {
              assert.equal(result.decision, "ready");
              assert.equal(result.pageReady, true);
              assert.equal(result.composerReady, true);
              assert.equal(result.composerState, "empty");
              assert.equal(result.authenticated, true);
              assert.equal(result.challengePresent, false);
              assert.equal(result.targetId, "target-invariant");
            }
          }
        }
      }
    }
  }
});

test("cleanup closes only the bound collaborator target when preserving a draft", () => {
  const result = planEgoCleanup({
    targetIds: ["target-draft", "target-collaborator"],
    boundTargetId: "target-collaborator",
    preservedDraftTargetId: "target-draft",
  });

  assert.deepEqual(result, {
    safe: true,
    failureReason: null,
    closeTargetIds: ["target-collaborator"],
    preserveTargetIds: ["target-draft"],
    keepTaskSpace: true,
  });
});

test("cleanup emits no close operation when collaborator and draft targets collide", () => {
  const result = planEgoCleanup({
    targetIds: ["target-shared"],
    boundTargetId: "target-shared",
    preservedDraftTargetId: "target-shared",
  });

  assert.deepEqual(result, {
    safe: false,
    failureReason: "cleanup_targets_not_distinct",
    closeTargetIds: [],
    preserveTargetIds: ["target-shared"],
    keepTaskSpace: true,
  });
});

test("cleanup emits no operation when the live targets differ from the binding", () => {
  const result = planEgoCleanup({
    targetIds: ["target-collaborator"],
    boundTargetId: "target-collaborator",
    preservedDraftTargetId: "target-draft",
  });

  assert.deepEqual(result, {
    safe: false,
    failureReason: "cleanup_targets_changed",
    closeTargetIds: [],
    preserveTargetIds: ["target-draft"],
    keepTaskSpace: true,
  });
});

test("cleanup closes the whole task space when no draft target was preserved", () => {
  const result = planEgoCleanup({
    targetIds: ["target-collaborator"],
    boundTargetId: "target-collaborator",
    preservedDraftTargetId: null,
  });

  assert.deepEqual(result, {
    safe: true,
    failureReason: null,
    closeTargetIds: [],
    preserveTargetIds: [],
    keepTaskSpace: false,
  });
});

test("whole-space cleanup emits no mutation when an additional target appears", () => {
  const result = planEgoCleanup({
    targetIds: ["target-collaborator", "target-unexpected"],
    boundTargetId: "target-collaborator",
    preservedDraftTargetId: null,
  });

  assert.deepEqual(result, {
    safe: false,
    failureReason: "cleanup_targets_changed",
    closeTargetIds: [],
    preserveTargetIds: ["target-collaborator", "target-unexpected"],
    keepTaskSpace: true,
  });
});

test("cleanup rejects duplicate live target identities", () => {
  assert.throws(
    () => planEgoCleanup({
      targetIds: ["target-duplicate", "target-duplicate"],
      boundTargetId: "target-duplicate",
      preservedDraftTargetId: null,
    }),
    { code: "EGO_CLEANUP_INPUT_INVALID" },
  );
});
