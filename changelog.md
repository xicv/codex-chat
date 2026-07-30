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
