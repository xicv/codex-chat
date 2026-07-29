# Versioned limits

Protocol v1 uses the constants exported by `scripts/lib/limits.mjs`.

| Area | Limit |
| --- | ---: |
| Selected files | 64 |
| Bytes per selected file | 131,072 |
| Aggregate selected bytes | 524,288 |
| Serialized context artifact | 786,432 |
| Result envelope bytes | 262,144 |
| Unified diff bytes | 131,072 |
| Unified diff lines | 4,096 |
| Unified diff hunks | 64 |
| Postimage bytes | 262,144 |
| Verification plan bytes | 32,768 |
| Verification argv items | 64 |
| Bytes per argv item | 8,192 |
| Verification timeout | 600,000 ms |
| Captured stdout plus stderr | 1,048,576 bytes |
| Ledger event data | 65,536 bytes |
| Idempotency key | 256 bytes |

The ledger retains the 128 most recent general idempotency keys. Outbound reservation and confirmation keys are retained for the full run.

Changing a limit is a protocol/contract change and requires corresponding tests and schema updates.
