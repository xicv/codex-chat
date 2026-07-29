export const LIMITS_V1 = Object.freeze({
  pack: Object.freeze({
    maxFiles: 64,
    maxFileBytes: 128 * 1024,
    maxTotalBytes: 512 * 1024,
    maxArtifactBytes: 768 * 1024,
  }),
  result: Object.freeze({
    maxResultBytes: 256 * 1024,
    maxPatchBytes: 128 * 1024,
    maxPatchLines: 4096,
    maxHunks: 64,
    maxPostimageBytes: 256 * 1024,
  }),
  verify: Object.freeze({
    maxPlanBytes: 32 * 1024,
    maxArgvItems: 64,
    maxArgBytes: 8192,
    maxTimeoutMs: 600_000,
    maxOutputBytes: 1024 * 1024,
  }),
  ledger: Object.freeze({
    maxEventDataBytes: 64 * 1024,
    maxIdempotencyKeyBytes: 256,
    retainedIdempotencyKeys: 128,
  }),
});
