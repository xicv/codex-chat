# Versioned limits

Protocol v1 uses the constants exported by `scripts/lib/limits.mjs`.

| Area | Limit |
| --- | ---: |
| Selected files | 64 |
| Bytes per selected file | 131,072 |
| Aggregate selected bytes | 524,288 |
| Serialized context artifact | 786,432 |
| Result envelope bytes | 262,144 |
| Full terminal capture bytes | 2,097,152 |
| Serialized terminal capture receipt | 32,768 |
| Unified diff bytes | 131,072 |
| Unified diff lines | 4,096 |
| Unified diff hunks | 64 |
| Postimage bytes | 262,144 |
| Scanner subprocess | 5,000 ms |
| Scanner output | 131,072 bytes |
| Verification plan bytes | 32,768 |
| Verification argv items | 64 |
| Bytes per argv item | 8,192 |
| Verification timeout | 600,000 ms |
| Captured stdout plus stderr | 1,048,576 bytes |
| Ledger event data | 65,536 bytes |
| Events per run history segment | 1,024 |
| Reserved terminal-completion events | 32 |
| Idempotency key | 256 bytes |

The ledger retains the 128 most recent general idempotency keys and matching
records. Outbound reservation and confirmation keys and records are retained
for the full run. Equivalent resource observations may opt into a fixed
5,000 ms coalescing window. The last 32 event slots are reserved for terminal
capture, review, declared verification gates, acceptance, or blocking. Longer
histories start a new run whose `parent` binds the prior run ID, exact sequence,
and event hash.

Changing a limit is a protocol/contract change and requires corresponding tests and schema updates.

Size-aware transport manifest v1 uses these fixed limits:

| Area | Limit |
| --- | ---: |
| Input portable context | 786,432 bytes |
| Input task envelope | 65,536 bytes |
| Composer task envelope | 32,768 bytes |
| Inline context | 24,576 bytes |
| Inline composer envelope | 49,152 bytes |
| Serialized transport manifest | 131,072 bytes |

The manifest is a deterministic, scanned plan. It never grants upload, send,
resend, provider acceptance, or model-visibility authority.

Typed manifest v2 uses these fixed limits:

| Area | Limit |
| --- | ---: |
| Manifest plan | 131,072 bytes |
| Representations | 64 |
| Bytes per representation | 10,485,760 |
| Aggregate representation bytes | 52,428,800 |
| Serialized sidecar | 524,288 bytes |

The larger representation limits do not imply that a transport can upload the
files or that a model can see them. Transport capability and delivery evidence
are separate gates.

Delivery receipt v2 uses these fixed limits:

| Area | Limit |
| --- | ---: |
| Input context manifest | 524,288 bytes |
| Delivery receipt plan | 65,536 bytes |
| Raw observation evidence | 10,485,760 bytes |
| Attachment ordinal slots | 64 |
| Provider identifier | 1,024 bytes |
| Serialized delivery receipt | 65,536 bytes |

These limits bound one immutable representation observation per receipt. They
do not grant transport upload capacity or establish model visibility.

Local Ego bootstrap coordination uses these fixed lease limits:

| Area | Limit |
| --- | ---: |
| Minimum lease TTL | 60,000 ms |
| Default lease TTL | 900,000 ms |
| Maximum lease TTL | 3,600,000 ms |

The owner renews immediately before each bounded Ego invocation. The maximum
does not make the lease a cross-host fencing authority.

Distributed coordination v1 uses these fixed ceilings:

| Area | Limit |
| --- | ---: |
| Coordinator lease TTL | 1,000-300,000 ms |
| Idempotency records per segment | 16,384 |
| Serialized idempotency results per segment | 33,554,432 bytes |
| Message tombstones per segment | 16,384 |
| Retained mailbox payloads per segment | 33,554,432 bytes |
| Events per distributed run | 100,000 |
| Authoritative journal | 67,108,864 bytes |
| Rebuildable snapshot | 134,217,728 bytes |
| Snapshot checkpoint interval | 64 mutations |
| Active messages per mailbox | 128 |
| Active payload bytes per mailbox | 1,048,576 bytes |
| In-flight messages per mailbox | 16 |
| One mailbox message | 65,536 bytes |
| Retained messages per mailbox | 512 |
| Message IDs per prune | 128 |
| Claim visibility | 1,000-300,000 ms |
| Bearer token | 32-4,096 bytes |
| HTTP request | 131,072 bytes |
| HTTP response | 1,048,576 bytes |
| HTTP request timeout | 10,000 ms |
| HTTP headers timeout | 5,000 ms |
| HTTP requests per source/window | 600 / 60,000 ms |
| Tracked rate-limit sources | 4,096 |

Programmatic mailbox limit overrides may tighten but never weaken these
ceilings. Lifetime segment limits preserve permanent successful-mutation
idempotency and message-ID tombstones. Rotate only after every run in the
segment is terminal and the complete state directory is archived; active
segment rotation would discard safety state.
