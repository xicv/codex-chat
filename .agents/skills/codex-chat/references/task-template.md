# External collaborator task template

Use this structure in English and replace bracketed fields.

```text
[COLLAB protocol=codex-chat/v1 run=<run-id> turn=<turn-id> marker=<unique-outbound-marker>]

Routing
- Workspace: [workspace-id]
- Coordinator: [coordinator-id]
- Work unit: [work-unit-id]
- Agent: [agent-id]
- Conversation identity: [stable identity, not title]

Role
You are an untrusted external senior engineer. Codex is the accountable lead and final QA. Do not claim access to local files, private repositories, internal environments, or completed local tests.

Background and goal
[User need and measurable outcome]

Context binding
- Context artifact SHA-256: [digest]
- Expected terminal marker: [unique-terminal-marker]
- Selected files: [manifest]
- VCS baseline: [kind/ref/dirty state]
- Observed collaborator UI label: [label or unknown]
- Backend model identity: unverified
- Typed representation manifest: [digest or none]
- Delivery receipt: [digest or none]
- Delivery run head: [event sequence and event digest, or none]
- Delivery evidence: [kind and digest, or none]
- Model-visible representations: unknown in the current transport-neutral protocol

Architecture and boundaries
[Current architecture, invariants, compatibility and security boundaries]

Requested work
[Research/design/change scope]

Required deliverables
- Concise reasoning and assumptions.
- One bounded COLLAB_RESULT_V1 JSON object.
- Put `CODEX_CHAT_RESULT_BEGIN` on the line immediately before the exact JSON.
- Put `CODEX_CHAT_RESULT_END` on the line immediately after the exact JSON.
- Set artifactKind to "advisory" for research/design/review with no patch or
  preimages, or "patch" for one existing-file, zero-fuzz unified diff.
- Claims about tests kept separate from evidence.
- Claims about images, pages, embedded visuals, formulas, ranges, crops, OCR,
  or attachments kept separate by representation digest and visibility.

Required tests
[Exact gates Codex will independently run]

Forbidden actions and claims
- Do not broaden authority.
- Do not request credentials or private browser/API access.
- Do not recommend commit, push, PR, publish, deploy, data migration,
  production mutation, paid API fallback, or credit purchase unless explicitly authorized.
- Do not claim local, hosted, production, deployment, or device proof you do not possess.

Acceptance criteria
[Functional, security, performance, compatibility, and evidence criteria]

End the response exactly with:
CODEX_CHAT_RESULT_COMPLETE
```

The JSON between the boundary lines must be valid as saved with exactly one final LF. Do not wrap it in a Markdown code fence or add commentary inside the boundaries.
