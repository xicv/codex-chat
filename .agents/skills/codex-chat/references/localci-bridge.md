# LocalCI Bridge handoff adapter

The personal skill installer exposes the existing `codex-chat` command. Run this companion adapter from the installed skill path shown below. An npm-linked repository also exposes `codex-chat-localci-bridge`.

LocalCI Bridge is a separate private GitHub queue. It is not a browser
transport and it does not grant Codex authority to execute, merge, deploy, or
release. The adapter in this skill independently validates a bridge job or
result before Codex uses it as a review handoff.

## Validate a job

Supply the repository and complete base SHA from an independent GitHub query,
not from the job file alone:

```bash
node ~/.codex/skills/codex-chat/scripts/localci-bridge.mjs job-validate \
  --file queue/requests/<job-id>.json \
  --repository xicv/PeoplePlanner \
  --base-sha <complete-main-sha>
```

Validation rejects extra fields, secret-like text, Gmail message/thread IDs,
unsafe or protected paths, wrong verification profiles, raw execution
authority, and any merge/deploy/release permission. Files pass through the
shared no-follow, bounded trusted-file snapshot boundary.

## Validate a result

First query the PeoplePlanner PR through GitHub and independently record its
current head SHA and PR number. Then run:

```bash
node ~/.codex/skills/codex-chat/scripts/localci-bridge.mjs result-validate \
  --job queue/requests/<job-id>.json \
  --result queue/results/<job-id>.json \
  --repository xicv/PeoplePlanner \
  --base-sha <complete-requested-base-sha> \
  --head-sha <complete-current-pr-head-sha> \
  --pr-number <current-pr-number>
```

A valid result proves only that the handoff file is structurally consistent
with the supplied identities. It does not prove that CI claims are current and
never authorizes action, merge, deployment, or release. Codex must still query
current GitHub checks and reviews, inspect the exact diff, and run independent
verification on the new Mac.

The browser collaborator flow and LocalCI Bridge are separate transports. Do
not treat one as a retry or fallback for an ambiguous send in the other.
