import { MODEL_LOCK, ARCTIC_QUERY_PREFIX, chunkTokenizerVersion } from "@quixi/quixi-embed";
import type { EmbeddingAssets } from "@quixi/quixi-embed/service";
import type { EmbeddingModelIdentity } from "@quixi/core/contracts";
import scalarWasmUrl from "@quixi/quixi-embed/artifacts/1.0.2/quixi-scalar.wasm?url";
import simdWasmUrl from "@quixi/quixi-embed/artifacts/1.0.2/quixi-simd.wasm?url";
import tokenizerUrl from "@quixi/quixi-embed/artifacts/model/arctic-xs.qxtokenizer?url";
import baseline from "@quixi/quixi-embed/kernels/baseline.wgsl?raw";
import tiled from "@quixi/quixi-embed/kernels/tiled.wgsl?raw";
import half from "@quixi/quixi-embed/kernels/half.wgsl?raw";
import attention from "@quixi/quixi-embed/kernels/attention.wgsl?raw";

/** Hosts name where the separately provisioned model lives; every other
 * runtime asset is bundled with the application and pinned by the lock. */
export interface EmbeddingHostOptions {
  modelUrl: string;
  preferGpu?: boolean;
  /** OPFS directory for the verified model copy; null keeps it in memory only. */
  cacheDirectory?: string | null;
}
/** Product §71: the identity stored beside every vector. `chunkingVersion`
 * is the storage index version so a chunk-policy change invalidates vectors. */
export function embeddingModelIdentity(chunkingVersion: string): EmbeddingModelIdentity {
  return {
    modelName: MODEL_LOCK.modelName,
    modelVersion: MODEL_LOCK.sourceRevision,
    sourceHash: MODEL_LOCK.model.sha256,
    dimensions: MODEL_LOCK.dimensions,
    tokenizerVersion: chunkTokenizerVersion({ runtimeVersion: MODEL_LOCK.runtimeVersion, tokenizerSha256: MODEL_LOCK.tokenizer.sha256 }),
    preprocessingVersion: MODEL_LOCK.preprocessingVersion,
    chunkingVersion,
    storageRepresentation: "float32",
  };
}
export function embeddingAssets(host: EmbeddingHostOptions, chunkingVersion: string): EmbeddingAssets {
  const identity = embeddingModelIdentity(chunkingVersion);
  return {
    model: { url: host.modelUrl, sha256: MODEL_LOCK.model.sha256, bytes: MODEL_LOCK.model.bytes },
    tokenizer: { url: tokenizerUrl, sha256: MODEL_LOCK.tokenizer.sha256, bytes: MODEL_LOCK.tokenizer.bytes },
    scalarWasm: { url: scalarWasmUrl, sha256: MODEL_LOCK.wasm.scalar.sha256 },
    simdWasm: { url: simdWasmUrl, sha256: MODEL_LOCK.wasm.simd.sha256 },
    shaders: { baseline, tiled, half, attention },
    identity: {
      modelHash: MODEL_LOCK.sourceCheckpointSha256,
      artifactHash: MODEL_LOCK.model.sha256,
      tokenizerVersion: identity.tokenizerVersion,
      preprocessingVersion: identity.preprocessingVersion,
      chunkingVersion,
      queryPrefix: ARCTIC_QUERY_PREFIX,
    },
  };
}
