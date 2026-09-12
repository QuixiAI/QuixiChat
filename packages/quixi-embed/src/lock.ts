/** Typed mirror of artifacts/model/lock.json; a test asserts both agree. */
export const MODEL_LOCK = Object.freeze({
  modelName: 'snowflake-arctic-embed-xs',
  sourceRevision: 'd8c86521100d3556476a063fc2342036d45c106f',
  sourceCheckpointSha256: 'ee789e0b1d6ecbbd5ce37b474af556cc1a1319cee4417d9e3b11f82e90300706',
  modelFormatVersion: 1,
  dimensions: 384,
  maxTokens: 512,
  preprocessingVersion: 'arctic-query-prefix-v1',
  runtimeVersion: '1.0.2',
  model: { file: 'arctic-xs.qxmodel', bytes: 90_785_583, sha256: 'e1ef345cd35088b06f70c199f5a4e0311bda5983716ad6a3e7d0a604202efffc' },
  tokenizer: { file: 'arctic-xs.qxtokenizer', bytes: 514_223, sha256: 'd15cd90acf9df73913b5c7f8af9ddc7c2d8afee8e4777f6f71e6d1bb4875c8db' },
  wasm: {
    scalar: { sha256: 'e477d3e35b6e83c39e206e76079a4d5136a227711a0124b64bf885f3165cee65' },
    simd: { sha256: 'd07bbc26c3f35731d7e2c6885405205a64852f40f9d7c5878c6efe77e8f9b198' },
  },
} as const);
