export function buildRecoveryPlan(state) {
  const reservationPending = state.phase === "send_reserved";
  const observeOnly = [
    "send_confirmed",
    "response_pending_unknown",
    "human_required",
  ].includes(state.phase);
  const terminal = ["accepted", "blocked"].includes(state.phase);
  const locator = state.outbound?.confirmationEvidence?.locator ?? null;
  return {
    kind: "CODEX_CHAT_TRANSPORT_RECOVERY_PLAN_V1",
    protocolVersion: 1,
    runHead: {
      runId: state.runId,
      eventSequence: state.eventCount,
      eventHash: state.lastEventHash,
      phase: state.phase,
    },
    routing: state.outbound?.routing ?? null,
    mode: terminal ? "terminal" : "read-only",
    sendAllowed: false,
    resendAllowed: false,
    markerReconciliationRequired: reservationPending,
    conclusiveMarkerAbsenceMayReturnToController: reservationPending,
    observationsAllowed: reservationPending || observeOnly,
    outbound: state.outbound
      ? {
          turnId: state.outbound.turnId,
          marker: state.outbound.marker,
          expectedTerminalMarker: state.outbound.expectedTerminalMarker,
          providerNamespace: state.outbound.providerNamespace,
          conversationIdentity: state.outbound.conversationIdentity,
          locator,
        }
      : null,
    conversationLeases: state.conversationLeases ?? [],
    allowedLedgerEvents: reservationPending
      ? ["send_confirmed", "send_ambiguous", "blocked", "human_required"]
      : observeOnly
        ? [
            "response_observed",
            "response_terminal",
            "transport_disconnected",
            "resource_observation",
            "suspended_both_limited",
            "provider_terminal_failure",
            "blocked",
            "human_required",
          ]
        : [],
    forbiddenTransportActions: [
      "send",
      "resend",
      "change-conversation",
      "create-conversation",
    ],
    nextAction: state.nextAction,
  };
}
