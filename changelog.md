# Changelog

Notable project changes are recorded here from the Git history. The repository
does not yet have release tags, so dated sections link to the feature commits
that introduced each change; merge-only commits are omitted.

## Unreleased

### Added

- A committed-`main` local installer that synchronizes the personal Codex skill
  to `~/.codex/skills/codex-chat` and exposes the bundled CLI through
  `~/.local/bin/codex-chat`.
- Repository-local `reference-transaction` and `pre-push` hooks that keep the
  personal installation current while excluding dirty and untracked files.
- Read-only installation parity checks and regression coverage for drift
  repair, non-`main` rejection, unsafe targets, CLI conflicts, hook-driven
  commits and fast-forward pulls, and pre-push synchronization.
- A zero-egress browser transport gate that runs before source packaging,
  bounds recovery from a closed `node_repl` transport, and preserves ambiguous
  send semantics.
- A provider-readiness gate that opens or claims the intended collaborator
  conversation and verifies an authenticated composer before selecting or
  packaging source.
- An app-wide transport circuit breaker that serializes health probes across
  coordinators, remembers the exact failed browser-host generation, suppresses
  repeated calls into a closed transport, and verifies that recovery actually
  changed the host process before one half-open probe.
- A one-shot Ego Browser fallback after conclusive pre-send primary failure,
  with isolated task spaces, bounded readiness output, user-owned
  authentication, immutable per-run transport selection, and provider-level
  conversation leasing across transports.
- A capability-protected Ego bootstrap lease that serializes the account-level
  draft seam before a conversation identity exists, stores only a token digest,
  rejects expired owners, and overlaps the durable conversation lease handoff.
- A neutral transport-probe release that frees an unused primary claim without
  falsely marking the browser host healthy or failed.
- A bounded external-response observation budget that permits durable local
  takeover without cancelling, resending, switching transports, closing the
  bound task space, or misclassifying a still-running provider response.
- Capacity-neutral `mail.peek` polling and optional exact
  message/delivery-attempt binding for the subsequent fenced claim.
- Immutable rejection receipts for schema-invalid collaborator results, with a
  correction-only `response_rejected` transition.

### Fixed

- Duplicate skill selector guidance now keeps the personal installation
  canonical while disabling only this repository's authoring copy.
- Browser transport failures no longer spend time building and scanning a
  capsule before discovering that no browser-backed submission is possible.
- Provider navigation, authentication, or composer failures now stop before
  capsule preparation instead of after source has already been packaged.
- Account-restored ChatGPT drafts in new Ego task spaces are now detected
  during zero-egress readiness. The fallback preserves the draft, tries one
  source-free distinct tab, binds the run to its exact target, and reselects
  that target for compose, submit, observe, and cleanup instead of pausing
  after capsule preparation or asking the user to submit unknown content.
  Unknown draft text no longer participates in login/account control detection,
  and cleanup reasserts distinct collaborator/draft targets before closing one.
- Restart guidance is no longer trusted as an action: unchanged ChatGPT and
  browser-host generations keep the circuit open and prevent another
  `node_repl` call.
- Browser fallback can no longer start after a possible upload or send, and a
  failed selected transport cannot trigger a retry through another browser.
- Ego submission no longer uses append-prone `fillInput` or Enter on ChatGPT's
  contenteditable composer. It now rejects unknown persisted drafts, verifies
  the exact reserved envelope and one send control, clicks once, and reconciles
  missing command output without resending. Temporary `/c/WEB:` paths are
  treated as provisional until a stable provider conversation locator appears.
- Multiline Ego drafts no longer fail exact-envelope checks because
  ProseMirror's `innerText` inflates paragraph breaks. The fallback reconstructs
  exact paragraph text, preserves empty lines, and stops on unsupported composer
  DOM without clearing, typing, or sending.
- Ego compose scripts now load persisted envelopes with an ESM-safe dynamic
  import, avoiding the pre-browser module-format failure caused by mixing
  CommonJS `require` with top-level `await`.
- Quiet mailbox polling no longer exhausts the control plane's permanent
  idempotency capacity, and a claim can now fail closed if another consumer
  wins after the availability probe.
- Malformed terminal result envelopes no longer leave valid response evidence
  outside the run state machine; their exact bytes and validation error are
  captured before requesting a fresh correction turn.

## 2026-07-30

### Added

- [Distributed coordination control plane](https://github.com/xicv/codex-chat/commit/06b8e749c078206508030fabff5eaee12a14f396)
  with coordinator epochs and fencing, exact distributed run heads,
  provider-conversation claims, bounded partitioned mailboxes, durable
  idempotency, rate limits, and authenticated HTTP transport.

## 2026-07-29

### Added

- [Initial safety-first skill and deterministic CLI](https://github.com/xicv/codex-chat/commit/a88dc808206914f8fc7dd073c786df2e813f3995)
  for preflight validation, minimal context packing, durable run state,
  quarantined result import, and digest-pinned local verification.
- [Typed context provenance and delivery evidence](https://github.com/xicv/codex-chat/commit/8aef488c126def5ebdb13769eaae0732619e0acd)
  with representation-specific manifests, immutable transport receipts,
  target-specific file locking, and coordinated acceptance gates.
- [Multi-coordinator hardening](https://github.com/xicv/codex-chat/commit/0efc834300b9d64555b243b08c395db1e92409c7)
  with cross-run conversation leases, create-once terminal captures,
  deterministic recovery plans, bounded ledgers, and receipt revalidation.

### Changed

- [Project icon made transparent](https://github.com/xicv/codex-chat/commit/501e7e3b43697d58d9f792dff1004ec0c07185b1)
  for cleaner rendering across themes.
