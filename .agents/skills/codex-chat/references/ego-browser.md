# Ego Browser fallback

Ego Browser is a pre-send fallback for `codex-chat`. Use it only after the
built-in Browser is conclusively unavailable during the zero-source-egress
gate. Never switch to Ego because the primary provider page is logged out,
challenged, rate-limited, or missing a composer while the built-in Browser
transport itself is healthy.

## Eligibility

Before source selection, packing, scanning, run creation, or send reservation:

1. Read the installed `ego-browser` skill completely.
2. Require the Ego skill and its CLI to be available locally. Do not use
   `which ego-browser`; the first required Ego invocation is the availability
   check. If the command is missing, disconnected, or cannot create a task
   space, stop without installing, retrying, or selecting a third surface.
3. Never inspect cookies, profiles, passwords, tokens, or session storage, and
   do not transfer credential material. The user owns installation, login,
   account selection, CAPTCHA, passkeys, passwords, and two-factor
   verification.
4. After acquiring bootstrap ownership below, create one isolated task space
   with an opaque random preflight identity.
   Never put repository paths, source, task text, or user data in its name.

## Acquire bootstrap ownership

Before the first `ego-browser` invocation, acquire the single local lease for
the ChatGPT account-level draft seam. Use the immutable route that this
coordinator has already chosen; `attempt-id` is a fresh ID for this pre-run
fallback attempt:

```bash
node <skill>/scripts/codex-chat.mjs ego-bootstrap-lease \
  --action acquire \
  --workspace-id <workspace-id> \
  --coordinator-id <coordinator-id> \
  --work-unit-id <work-unit-id> \
  --agent-id <agent-id> \
  --attempt-id <attempt-id>
```

Keep the returned `leaseId`, `leaseToken`, `generation`, and `expiresAt` in
the local controller. The token is a local capability: never persist its raw
value in the lease record, pass `leaseToken` to Ego or another browser, place
it in the collaboration capsule, or quote it in a report. If `acquired` is
false, stop before invoking Ego, creating a task space, selecting source, or
waiting for the other owner. Do not change state directories or identities to
bypass `bootstrap_in_progress`.

The default lease lasts fifteen minutes. Renew the exact capability before it
expires whenever readiness, user handoff, or source preparation continues:

```bash
node <skill>/scripts/codex-chat.mjs ego-bootstrap-lease \
  --action renew \
  --workspace-id <workspace-id> \
  --coordinator-id <coordinator-id> \
  --work-unit-id <work-unit-id> \
  --agent-id <agent-id> \
  --attempt-id <attempt-id> \
  --lease-id <lease-id> \
  --lease-token <lease-token>
```

Before handing a task space to the user for authentication, renew with
`--ttl-ms 3600000`. If renewal later reports expiry or an ownership mismatch,
do not take the task space back or perform another Ego action. Hold the
bootstrap lease until `send_reserved` has durably acquired the normal logical
conversation lease. That ordering ensures one ownership mechanism is active
before the other is released.

On any earlier stop, first finish any permitted task-space cleanup, then
release the exact capability only after no Ego command remains in flight:

```bash
node <skill>/scripts/codex-chat.mjs ego-bootstrap-lease \
  --action release \
  --workspace-id <workspace-id> \
  --coordinator-id <coordinator-id> \
  --work-unit-id <work-unit-id> \
  --agent-id <agent-id> \
  --attempt-id <attempt-id> \
  --lease-id <lease-id> \
  --lease-token <lease-token>
```

Release the same way immediately after the conversation lease is durable.
This lease coordinates cooperative processes sharing one local transport-state
directory; its generation records takeovers but does not fence an Ego command
that was already in flight when a lease expired. Renew immediately before each
bounded Ego invocation. This is not a cross-host authority; hosts sharing an
account still need an externally authoritative bootstrap owner.

## One read-only readiness attempt

Run one direct Ego heredoc. Keep the returned `preflightId`, numeric
`taskSpaceId`, and exact browser `targetId`. The attempt must classify the
composer draft before source selection, packing, scanning, run creation, or
send reservation. Adapt selectors only to the currently visible ChatGPT page;
do not broaden the observation or print page contents.

ChatGPT can restore an account-level draft into a newly created Ego task
space. A new task space therefore does not prove an empty composer. The
readiness attempt must:

1. Open `https://chatgpt.com/`, record its exact target ID, and inspect the
   authenticated composer without returning its text.
2. Classify the composer as `empty`, `nonempty`, or `unsupported`. For a
   ProseMirror composer, use the exact direct-`<p>` `textContent` joining rule
   from [Submit one bound turn](#submit-one-bound-turn); do not use
   `innerText`, trim, or print a digest of the draft.
3. If it is empty, bind that target. If it is nonempty, leave the inherited
   draft and its original tab untouched and make one source-free fresh-tab
   attempt with the unique URL
   `https://chatgpt.com/#codex-chat-${preflightId}`. Verify that the fresh
   target ID differs from the inherited-draft target ID and that the fresh
   target has an authenticated, challenge-free, empty supported composer.
4. If the fresh target is not distinct and ready, stop before source work.
   Preserve the inherited-draft tab. Do not retry, clear, overwrite, inspect,
   or submit the draft.

Replace `<skill>` below with the exact current installed `codex-chat` skill
directory. The browser adapter returns only bounded observations to the local
`ego-readiness.mjs` decision core. That module rejects unknown fields and
never accepts draft bytes; do not reproduce or modify its decisions inline.

```bash
CODEX_CHAT_SKILL_DIR="<skill>" ego-browser nodejs <<'EOF'
const skillDir = process.env.CODEX_CHAT_SKILL_DIR
if (!skillDir) throw new Error("codex-chat skill directory is required")
const { join } = await import("node:path")
const { pathToFileURL } = await import("node:url")
const readinessModulePath = join(
  skillDir,
  "scripts",
  "lib",
  "ego-readiness.mjs",
)
const { decideEgoReadiness } = await import(
  pathToFileURL(readinessModulePath).href
)
const preflightId = crypto.randomUUID()
const task = await useOrCreateTaskSpace(`codex-chat-fallback-${preflightId}`)
const initialTab = await openOrReuseTab('https://chatgpt.com/', {
  wait: true,
  timeout: 30,
})

const inspectReadiness = async () => {
  const info = await pageInfo()
  const snapshot = await snapshotText()
  const page = await js(String.raw`
(() => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      box.width > 0 &&
      box.height > 0
  }
  const nodes = [...document.querySelectorAll(
    'button, a, textarea, [contenteditable="true"]'
  )].filter(visible)
  const controlLabel = (element) => [
    element.getAttribute('aria-label'),
    element.getAttribute('data-testid'),
    element.textContent,
  ].filter(Boolean).join(' ').toLowerCase()
  const fieldLabel = (element) => [
    element.getAttribute('aria-label'),
    element.getAttribute('data-testid'),
    element.getAttribute('placeholder'),
    element.getAttribute('data-placeholder'),
    element.getAttribute('id'),
    element.getAttribute('name'),
  ].filter(Boolean).join(' ').toLowerCase()
  const controls = nodes.filter((element) =>
    element.matches('button, a')
  )
  const composer = nodes.find((element) =>
    element.matches('textarea, [contenteditable="true"]') &&
    /prompt|message|composer|chat/.test(fieldLabel(element))
  )
  const login = controls.some((element) =>
    /log in|sign in/.test(controlLabel(element))
  )
  const profile = controls.some((element) =>
    /profile|account|user menu/.test(controlLabel(element))
  )
  const challenge = Boolean(document.querySelector(
    'iframe[src*="captcha"], iframe[src*="challenge"], ' +
    '[id*="captcha"], [class*="captcha"], [data-testid*="challenge"]'
  )) || /captcha|verify you are human|security challenge/i.test(document.title)
  let composerState = "unsupported"
  if (composer instanceof HTMLTextAreaElement) {
    composerState = composer.value.length === 0 ? "empty" : "nonempty"
  } else if (composer instanceof HTMLElement) {
    const children = [...composer.children]
    if (children.every((child) => child.tagName === "P")) {
      const composerText = children
        .map((child) => child.textContent ?? "")
        .join("\n")
      composerState = composerText.length === 0 ? "empty" : "nonempty"
    }
  }
  return {
    providerOrigin: location.origin,
    providerPath: location.pathname,
    pageReady: ['interactive', 'complete'].includes(document.readyState),
    composerReady: Boolean(composer),
    composerState,
    accountUiPresent: profile,
    loginControlPresent: login,
    challengePresent: challenge,
  }
})()
`)
  return {
    ...page,
    pageReady: Boolean(info && snapshot && page.pageReady),
  }
}

const initialObservation = await inspectReadiness()
let decision = decideEgoReadiness({
  stage: "initial",
  initialTargetId: initialTab.targetId,
  candidateTargetId: initialTab.targetId,
  preservedDraftTargetId: null,
  observation: initialObservation,
})

if (decision.decision === "fresh_target_required") {
  try {
    const freshTab = await openOrReuseTab(
      `https://chatgpt.com/#codex-chat-${preflightId}`,
      { wait: true, timeout: 30 },
    )
    const candidateTargetId = freshTab?.targetId ?? initialTab.targetId
    let freshObservation = initialObservation
    if (candidateTargetId !== initialTab.targetId) {
      await switchTab(candidateTargetId)
      freshObservation = await inspectReadiness()
    }
    decision = decideEgoReadiness({
      stage: "fresh",
      initialTargetId: initialTab.targetId,
      candidateTargetId,
      preservedDraftTargetId: initialTab.targetId,
      observation: freshObservation,
    })
  } catch {
    decision = {
      ...decision,
      decision: "stop",
      ready: false,
      failureReason: "fresh_target_unavailable",
      targetId: null,
    }
  }
}

cliLog(JSON.stringify({
  preflightId,
  taskSpaceId: task.id,
  ...decision,
}))
EOF
```

Do not print the snapshot or conversation content, including the draft. The
permitted output is the bounded readiness object above. A passing result
requires `ready`, `pageReady`, `composerReady`, `authenticated`,
`composerState: "empty"`, no challenge, and an exact non-null `targetId`.
Never use unknown draft text to identify the composer, login, account, or
challenge state. Draft text may be read only for the local `empty`, `nonempty`,
or `unsupported` classification and must never be returned.
The final `decision`, `ready`, and `failureReason` fields come from the
executable local decision core. Only browser observation and bounded
transport-exception handling remain in the heredoc.
`accountUiPresent` is supporting evidence because the provider does not render
a labeled account control in every layout. A false required field, missing or
unsupported composer, nonempty fresh composer, reused target, or bounded
`failureReason` is a failed Ego attempt. Stop without source work. If terminal
output is missing, reconcile only by listing task spaces once; never repeat the
readiness action. Do not return to the built-in Browser or try a third surface.

When an inherited draft prevents readiness, report only that an unrelated
draft was preserved and that the external turn was not started. Never ask the
user to submit an unknown draft.

## User-owned authentication

If the page is logged out or presents an authentication or verification
challenge, hand control to the user and stop:

```bash
ego-browser nodejs <<'EOF'
const taskSpaceId = 7 // replace with the exact returned numeric ID
await handOffTaskSpace(taskSpaceId)
EOF
```

Never automate the challenge. Resume only after the user explicitly confirms
that login or verification is complete. Then call
`takeOverTaskSpace(taskSpaceId)` in a new Ego heredoc and perform one fresh
read-only readiness check in that same task space using the same bounded
observation adapter and `decideEgoReadiness` module. If that one recheck fails,
stop. Do not perform another handoff/recheck loop.

If readiness fails without an authentication handoff and no inherited draft
was preserved, close the returned numeric task-space ID in a dedicated heredoc
before stopping. If an inherited draft was preserved, keep the task space and
its original tab for the user.

## Bind the selected transport

After readiness succeeds:

- Select `transportKind: "ego-browser"` for this run. Bind both `taskSpaceId`
  and `targetId` to the complete run, including corrections and response
  observation. Reuse the same numeric task-space ID for the complete run.
  Never substitute the current, newest, or similarly titled tab.
- After creating the durable run and before `send_reserved`, record a
  `resource_observation` for `transport` with the transport kind,
  `preflightId`, `taskSpaceId`, `targetId`, optional
  `preservedDraftTargetId`, source, observation time, and availability.
- Keep `providerNamespace`, logical conversation identity, outbound marker,
  turn, and canonical provider locator transport-independent. The task-space ID
  is transport evidence, not a provider conversation identity or locator.
  This keeps the existing provider-conversation leases effective when different
  coordinators or transports target the same ChatGPT conversation.
- Confirm an accepted send with the observed canonical ChatGPT conversation
  URL or thread identifier. Never use the Ego task-space name or page title as
  the locator.

If Ego fails after selection, stop and preserve the run's current delivery
classification. Do not return to the built-in Browser or try a third surface.
If an upload or send action might have run, record or preserve
`send_ambiguous`; never resend through another transport.

## Submit one bound turn

Create and persist the durable `send_reserved` marker, exact task envelope,
payload digest, and bound task-space and target IDs in the controller before
invoking Ego. Do not generate the marker inside a browser heredoc. A missing
terminal log must not make the delivery identity disappear with the browser
process.

Use separate bounded heredocs for compose, submit, and observe. Each heredoc
must take the already-persisted marker and task envelope as inputs and must use
the same bound numeric task-space ID. Activate that exact task space using the
ownership-appropriate helper from the installed Ego skill:
`useOrCreateTaskSpace(taskSpaceId)` normally, or
`takeOverTaskSpace(taskSpaceId)` only after a confirmed user handoff. Before
reading or mutating the page, reselect the bound target by listing tabs,
requiring exactly the recorded `targetId`, and calling `switchTab(targetId)`.
Perform this before every compose, submit, and observe command. If either
binding is absent, stop; never create or fall back to another task space or
tab.

Read an envelope file with an ESM-safe dynamic import:

```js
const { readFile } = await import("node:fs/promises")
const taskEnvelope = await readFile(taskEnvelopePath, "utf8")
```

Do not use CommonJS `require` in an Ego script that also uses top-level `await`;
Node rejects that ambiguous module format before any browser action.

In the compose heredoc:

1. Reconcile the durable marker read-only against submitted user turns before
   touching the composer.
2. Canonicalize the composer text to classify any stale draft. Do not use
   `innerText`: ProseMirror may expose one visual paragraph break as two newline
   characters, so an exact multiline envelope can appear different even when
   its content is unchanged. When the direct children are all `<p>` elements,
   reconstruct the canonical value exactly as:

   ```js
   const children = [...composer.children]
   const composerText = children
     .map((child) => child.textContent ?? "")
     .join("\n")
   ```

   Joining every direct paragraph, including an empty final paragraph,
   preserves empty paragraph elements and therefore leading, repeated, and
   trailing envelope newlines. Do not trim, Unicode-normalize, collapse
   whitespace, or replace non-breaking spaces. If the composer has text but
   its direct children are absent or include any non-`<p>` element, classify
   it as unsupported composer DOM and stop without clearing, typing, or
   sending. Never use `fillInput` for ChatGPT's `contenteditable`: it appends
   to the existing ProseMirror content instead of reliably replacing it.
3. If the normalized composer is empty, focus it and type the reserved envelope.
   Only call `typeText(taskEnvelope)` when the normalized composer is empty.
4. If the normalized composer exactly equals the expected task envelope, reuse
   it without typing.
5. For every other non-empty value, stop. Never clear or overwrite an unknown
   draft, even when it appears to come from an earlier failed run. Never ask
   the user to submit an unknown draft: submitting it could send unrelated
   content. Report that the bound collaborator tab diverged and leave it for
   user inspection without creating another tab or run.
6. Before leaving the compose heredoc, verify that the composer text exactly
   equals the expected task envelope, that the durable marker occurs once in
   it and zero times in submitted user turns, and that there is exactly one
   enabled send control. Derive a stable `sendLocator` from that enabled
   control and return only this bounded verification evidence.

In the separate submit heredoc, re-read the same task space and repeat every
pre-submit invariant: exact task envelope, one composer marker, no submitted
user marker, and exactly one enabled send control matching `sendLocator`. Then
perform the single mutating action:

```js
await click(sendLocator, { label: 'send reserved turn' })
```

Do not use Enter or `pressKey` to submit. Observe only long enough to determine
whether exactly one user turn contains the durable marker, then exit the submit
heredoc with a bounded accepted-or-ambiguous result.

ChatGPT may expose a temporary `/c/WEB:` path immediately after the click.
Treat that path as provisional transport state, never as the provider locator.
The read-only observe heredoc must wait for a stable canonical conversation locator:
a non-`WEB:` conversation path or another stable provider thread identifier.
Do not record `send_confirmed` from a provisional path. If the stable locator
cannot be observed, preserve the marker and classify the delivery evidence as
ambiguous instead of inventing a locator.

Use the third, read-only observe heredoc to reconcile the marker and collect
the collaborator result. If a compose, submit, or observe command has missing
terminal output, perform read-only marker reconciliation in a new bounded
heredoc and never resend. Classify exactly one submitted marker as accepted,
zero as absent only when the prior submit action provably did not run, and
every other or uncertain result as ambiguous.

## Finish the task space

When the run becomes terminal and no user handoff is active, close the task
space in a dedicated final Ego heredoc. Compute a cleanup plan before any
close or completion operation. The planner rejects identity collisions,
missing targets, duplicate targets, and unexpected additional targets when
whole-space cleanup is requested. If no inherited draft was preserved, close
the whole task space:

```bash
CODEX_CHAT_SKILL_DIR="<skill>" ego-browser nodejs <<'EOF'
const skillDir = process.env.CODEX_CHAT_SKILL_DIR
if (!skillDir) throw new Error("codex-chat skill directory is required")
const { join } = await import("node:path")
const { pathToFileURL } = await import("node:url")
const { planEgoCleanup } = await import(pathToFileURL(join(
  skillDir,
  "scripts",
  "lib",
  "ego-readiness.mjs",
)).href)
const taskSpaceId = 7 // replace with the bound numeric ID
const targetId = "TARGET_ID" // replace with the bound collaborator target
const task = await useOrCreateTaskSpace(taskSpaceId)
if (task.id !== taskSpaceId) throw new Error("bound task space changed")
const tabs = await listTabs()
const plan = planEgoCleanup({
  targetIds: tabs.map((tab) => tab.targetId),
  boundTargetId: targetId,
  preservedDraftTargetId: null,
})
if (!plan.safe || plan.keepTaskSpace) {
  throw new Error(plan.failureReason ?? "whole-space cleanup was not approved")
}
const completion = await completeTaskSpace(taskSpaceId, {
  keep: plan.keepTaskSpace,
})
if (!completion.done) throw new Error("task space was not closed")
EOF
```

If `preservedDraftTargetId` is present, reselect and close only the bound
collaborator tab by its exact `targetId`, then preserve the task space and
original draft tab:

```bash
CODEX_CHAT_SKILL_DIR="<skill>" ego-browser nodejs <<'EOF'
const skillDir = process.env.CODEX_CHAT_SKILL_DIR
if (!skillDir) throw new Error("codex-chat skill directory is required")
const { join } = await import("node:path")
const { pathToFileURL } = await import("node:url")
const { planEgoCleanup } = await import(pathToFileURL(join(
  skillDir,
  "scripts",
  "lib",
  "ego-readiness.mjs",
)).href)
const taskSpaceId = 7 // replace with the bound numeric ID
const targetId = "TARGET_ID" // replace with the bound collaborator target
const preservedDraftTargetId = "PRESERVED_TARGET_ID"
const task = await useOrCreateTaskSpace(taskSpaceId)
if (task.id !== taskSpaceId) throw new Error("bound task space changed")
const tabs = await listTabs()
const plan = planEgoCleanup({
  targetIds: tabs.map((tab) => tab.targetId),
  boundTargetId: targetId,
  preservedDraftTargetId,
})
if (!plan.safe || !plan.keepTaskSpace) {
  throw new Error(plan.failureReason ?? "draft-preserving cleanup was not approved")
}
for (const closeTargetId of plan.closeTargetIds) {
  await closeTab(closeTargetId)
}
const completion = await completeTaskSpace(taskSpaceId, {
  keep: plan.keepTaskSpace,
})
if (!completion.done) throw new Error("task space was not preserved")
EOF
```

Never close, clear, or submit the preserved draft tab. If the cleanup planner
returns `safe: false`, perform no cleanup mutation and report its bounded
failure reason.
