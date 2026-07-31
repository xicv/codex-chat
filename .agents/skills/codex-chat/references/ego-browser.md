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
4. Create one isolated task space with an opaque random preflight identity.
   Never put repository paths, source, task text, or user data in its name.

## One read-only readiness attempt

Run one direct Ego heredoc. Keep the returned `preflightId` and numeric
`taskSpaceId`. Adapt selectors only to the currently visible ChatGPT page; do
not broaden the observation or print page contents.

```bash
ego-browser nodejs <<'EOF'
const preflightId = crypto.randomUUID()
const task = await useOrCreateTaskSpace(`codex-chat-fallback-${preflightId}`)
await openOrReuseTab('https://chatgpt.com/', { wait: true, timeout: 30 })
const info = await pageInfo()
const snapshot = await snapshotText()
const readiness = await js(String.raw`
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
  const label = (element) => [
    element.getAttribute('aria-label'),
    element.getAttribute('data-testid'),
    element.textContent,
  ].filter(Boolean).join(' ').toLowerCase()
  const composer = nodes.some((element) =>
    element.matches('textarea, [contenteditable="true"]') &&
    /prompt|message|composer|chat/.test(label(element))
  )
  const login = nodes.some((element) =>
    /log in|sign in/.test(label(element))
  )
  const profile = nodes.some((element) =>
    /profile|account|user menu/.test(label(element))
  )
  const challenge = Boolean(document.querySelector(
    'iframe[src*="captcha"], iframe[src*="challenge"], ' +
    '[id*="captcha"], [class*="captcha"], [data-testid*="challenge"]'
  )) || /captcha|verify you are human|security challenge/i.test(document.title)
  return {
    origin: location.origin,
    path: location.pathname,
    pageReady: ['interactive', 'complete'].includes(document.readyState),
    composerReady: composer,
    accountUiPresent: profile,
    authenticated: composer && !login && !challenge,
    challengePresent: challenge,
  }
})()
`)
cliLog(JSON.stringify({
  preflightId,
  taskSpaceId: task.id,
  providerOrigin: readiness.origin,
  providerPath: readiness.path,
  pageReady: Boolean(info && snapshot && readiness.pageReady),
  composerReady: readiness.composerReady,
  accountUiPresent: readiness.accountUiPresent,
  authenticated: readiness.authenticated,
  challengePresent: readiness.challengePresent,
}))
EOF
```

Do not print the snapshot or conversation content. The permitted output is the
bounded readiness object above. Authentication readiness requires a ready
composer with no visible login or challenge; `accountUiPresent` is supporting
evidence because the provider does not render a labeled account control in
every layout. Treat a false `pageReady`, a missing composer, or a command,
connection, navigation, evaluation, or selector error as a failed Ego attempt
and stop. Do not return to the built-in Browser or try a third surface.

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
read-only readiness check in that same task space. If that one recheck fails,
stop. Do not perform another handoff/recheck loop.

If readiness fails without an authentication handoff and a numeric task-space
ID was returned, close that task space in a dedicated heredoc before stopping.

## Bind the selected transport

After readiness succeeds:

- Select `transportKind: "ego-browser"` for this run. Reuse the same numeric
  task-space ID for the complete run, including corrections and response
  observation.
- After creating the durable run and before `send_reserved`, record a
  `resource_observation` for `transport` with the transport kind,
  `preflightId`, `taskSpaceId`, source, observation time, and availability.
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
payload digest, and bound task-space ID in the controller before invoking Ego.
Do not generate the marker inside a browser heredoc. A missing terminal log must
not make the delivery identity disappear with the browser process.

Use separate bounded heredocs for compose, submit, and observe. Each heredoc
must take the already-persisted marker and task envelope as inputs and must use
the same bound numeric task-space ID.

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
   draft, even when it appears to come from an earlier failed run. Ask the user
   to preserve, submit, or discard that draft outside this run.
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
space in a dedicated final Ego heredoc:

```bash
ego-browser nodejs <<'EOF'
const taskSpaceId = 7 // replace with the bound numeric ID
await completeTaskSpace(taskSpaceId, { keep: false })
EOF
```
