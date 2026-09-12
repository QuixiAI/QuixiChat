/** Owned dedicated-worker embedding service. Importing this module starts no
 * worker, download or inference; `createEmbeddingService` does, with pinned assets. */
export { createEmbeddingService, createEmbeddingWorker } from './client.ts';
export type { EmbeddingService } from './client.ts';
export { EmbeddingServiceError, SERVICE_PROTOCOL_VERSION } from './protocol.ts';
export type { EmbeddingAssets, EmbeddingServiceOptions, EmbeddingBackendReport, EmbeddingServiceFailureCode } from './protocol.ts';
export { fetchVerified, sha256Hex } from './assets.ts';
export { runInferenceSelfTest, compareVector, SELF_TEST_THRESHOLDS } from './self-test.ts';
export type { InferenceSelfTest, InferenceCheck, InferenceCheckId, InferenceOutcome, SelfTestEnvironment } from './self-test.ts';
export { SELF_TEST_CASES, SELF_TEST_GOLDEN_MANIFEST_SHA256 } from './self-test-cases.ts';
