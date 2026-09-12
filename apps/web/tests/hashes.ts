// Synthetic browser test helper; Vite resolves the same incremental hash used
// by disk staging without allocating the whole fixture or archive.
export { sha256 } from "@noble/hashes/sha2.js";
export { bytesToHex } from "@noble/hashes/utils.js";
