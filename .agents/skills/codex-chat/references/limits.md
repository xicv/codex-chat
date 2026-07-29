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
