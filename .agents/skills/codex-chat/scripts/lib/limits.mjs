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
  terminalCapture: Object.freeze({
    maxCaptureBytes: 2 * 1024 * 1024,
    maxReceiptBytes: 32 * 1024,
  }),
  scanner: Object.freeze({
    maxProcessMs: 5_000,
    maxOutputBytes: 128 * 1024,
    killGraceMs: 500,
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
    maxEventsPerRun: 1024,
    completionEventReserve: 32,
    maxIdempotencyKeyBytes: 256,
    retainedIdempotencyKeys: 128,
    resourceObservationCoalesceMs: 5_000,
  }),
});

export const LIMITS_V2 = Object.freeze({
  manifest: Object.freeze({
    maxPlanBytes: 128 * 1024,
    maxRepresentations: 64,
    maxRepresentationBytes: 10 * 1024 * 1024,
    maxTotalBytes: 50 * 1024 * 1024,
    maxArtifactBytes: 512 * 1024,
  }),
  delivery: Object.freeze({
    maxManifestBytes: 512 * 1024,
    maxPlanBytes: 64 * 1024,
    maxEvidenceBytes: 10 * 1024 * 1024,
    maxRepresentations: 64,
    maxArtifactBytes: 64 * 1024,
    maxProviderIdBytes: 1024,
  }),
});
