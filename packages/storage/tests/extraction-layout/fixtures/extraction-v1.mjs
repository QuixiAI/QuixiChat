//#region node_modules/@noble/hashes/_u64.js
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE) {
	const h = fromNumH(n);
	const l = fromNumL(n);
	view.setUint32(byteOffset, isLE ? l : h, isLE);
	view.setUint32(byteOffset + 4, isLE ? h : l, isLE);
}
//#endregion
//#region node_modules/@noble/hashes/utils.js
/**
* Checks if something is Uint8Array. Be careful: nodejs Buffer will return true.
* @param a - value to test
* @returns `true` when the value is a Uint8Array-compatible view.
* @example
* Check whether a value is a Uint8Array-compatible view.
* ```ts
* isBytes(new Uint8Array([1, 2, 3]));
* ```
*/
function isBytes(a) {
	return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
/**
* Asserts something is a non-negative integer.
* @param n - number to validate
* @param title - label included in thrown errors
* @returns The validated number.
* @throws On wrong argument types. {@link TypeError}
* @throws On wrong argument ranges or values. {@link RangeError}
* @example
* Validate a non-negative integer option.
* ```ts
* anumber(32, 'length');
* ```
*/
function anumber(n, title = "") {
	if (typeof n !== "number") throw new TypeError(atitle(title) + "expected number, got " + typeof n);
	if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
	return n;
}
/**
* Asserts something is Uint8Array.
* @param value - value to validate
* @param length - optional exact length constraint
* @param title - label included in thrown errors
* @returns The validated byte array.
* @throws On wrong argument types. {@link TypeError}
* @throws On wrong argument ranges or values. {@link RangeError}
* @example
* Validate that a value is a byte array.
* ```ts
* abytes(new Uint8Array([1, 2, 3]));
* ```
*/
function abytes(value, length, title = "") {
	if (isBytes(value) && (length === void 0 || value.length === length)) return value;
	if (length !== void 0) anumber(length, "length");
	const bytes = isBytes(value);
	const ofLen = length !== void 0 ? ` of length ${length}` : "";
	const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
	const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
	if (!bytes) throw new TypeError(message);
	throw new RangeError(message);
}
var aobject = (value, label) => {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
	aobject(value, label);
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) throw new TypeError(`"${label}" expected plain object`);
	if (Object.hasOwn(value, "__proto__")) throw new TypeError(`"${label}.__proto__" is not allowed`);
};
/**
* Asserts a hash instance has not been destroyed or finished.
* @param instance - hash instance to validate
* @param checkFinished - whether to reject finalized instances
* @throws If the hash instance has already been destroyed or finalized. {@link Error}
* @example
* Validate that a hash instance is still usable.
* ```ts
* import { aexists } from '@noble/hashes/utils.js';
* import { sha256 } from '@noble/hashes/sha2.js';
* const hash = sha256.create();
* aexists(hash);
* ```
*/
function aexists(instance, checkFinished = true) {
	if (instance.destroyed) throw new Error("hash was destroyed");
	if (checkFinished && instance.finished) throw new Error("digest() was already called");
}
/**
* Asserts output is a sufficiently-sized byte array.
* @param out - destination buffer
* @param instance - hash instance providing output length
* Oversized buffers are allowed; downstream code only promises to fill the first `outputLen` bytes.
* @throws On wrong argument types. {@link TypeError}
* @throws On wrong argument ranges or values. {@link RangeError}
* @example
* Validate a caller-provided digest buffer.
* ```ts
* import { aoutput } from '@noble/hashes/utils.js';
* import { sha256 } from '@noble/hashes/sha2.js';
* const hash = sha256.create();
* aoutput(new Uint8Array(hash.outputLen), hash);
* ```
*/
function aoutput(out, instance) {
	abytes(out, void 0, "output");
	const min = instance.outputLen;
	if (!(out.length >= min)) throw new RangeError("\"output\" expected length >= " + min);
}
/**
* Zeroizes typed arrays in place. Warning: JS provides no guarantees.
* @param arrays - arrays to overwrite with zeros
* @example
* Zeroize sensitive buffers in place.
* ```ts
* clean(new Uint8Array([1, 2, 3]));
* ```
*/
function clean(...arrays) {
	for (let i = 0; i < arrays.length; i++) arrays[i].fill(0);
}
/**
* Creates a DataView for byte-level manipulation.
* @param arr - source typed array
* @returns DataView over the same buffer region.
* @example
* Create a DataView over an existing buffer.
* ```ts
* createView(new Uint8Array(4));
* ```
*/
function createView(arr) {
	return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
/**
* Rotate-right operation for uint32 values.
* @param word - source word
* @param shift - shift amount in bits
* @returns Rotated word.
* @example
* Rotate a 32-bit word to the right.
* ```ts
* rotr(0x12345678, 8);
* ```
*/
function rotr(word, shift) {
	return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function")();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
/**
* Convert byte array to hex string.
* Uses the built-in function when available and assumes it matches the tested
* fallback semantics.
* @param bytes - bytes to encode
* @returns Lowercase hexadecimal string.
* @throws On wrong argument types. {@link TypeError}
* @example
* Convert bytes to lowercase hexadecimal.
* ```ts
* bytesToHex(Uint8Array.from([0xca, 0xfe, 0x01, 0x23])); // 'cafe0123'
* ```
*/
function bytesToHex(bytes) {
	abytes(bytes);
	if (hasHexBuiltin) return bytes.toHex();
	let hex = "";
	for (let i = 0; i < bytes.length; i++) hex += hexes[bytes[i]];
	return hex;
}
/**
* Merges default options and passed options.
* @param defaults - base option object
* @param opts - user overrides
* @param title - label included in thrown override errors
* @returns Fresh merged option object with a null prototype.
* @throws On wrong argument types. {@link TypeError}
* @example
* Merge user overrides onto default options.
* ```ts
* checkOpts({ dkLen: 32 }, { asyncTick: 10 });
* ```
*/
function checkOpts(defaults, opts, title = "opts") {
	aopts(defaults, "defaults");
	if (opts !== void 0) aopts(opts, title);
	return Object.assign(Object.create(null), defaults, opts);
}
/**
* Creates a callable hash function from a stateful class constructor.
* @param hashCons - hash constructor or factory
* @param info - optional metadata such as DER OID
* @returns Frozen callable hash wrapper with `.create()`.
*   Wrapper construction eagerly calls `hashCons(undefined)` once to read
*   `outputLen` / `blockLen`, so constructor side effects happen at module
*   init time.
* @throws On wrong argument types. {@link TypeError}
* @example
* Wrap a stateful hash constructor into a callable helper.
* ```ts
* import { createHasher } from '@noble/hashes/utils.js';
* import { sha256 } from '@noble/hashes/sha2.js';
* const wrapped = createHasher(sha256.create, { oid: sha256.oid });
* wrapped(new Uint8Array([1]));
* ```
*/
function createHasher(hashCons, info = {}) {
	if (typeof hashCons !== "function") throw new TypeError("\"hashCons\" expected function, got type=" + typeof hashCons);
	info = checkOpts({}, info, "info");
	const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
	const tmp = hashCons(void 0);
	hashC.outputLen = tmp.outputLen;
	hashC.blockLen = tmp.blockLen;
	hashC.canXOF = tmp.canXOF;
	hashC.create = (opts) => hashCons(opts);
	Object.assign(hashC, info);
	return Object.freeze(hashC);
}
/**
* Creates OID metadata for NIST hashes with prefix `06 09 60 86 48 01 65 03 04 02`.
* @param suffix - final OID byte for the selected hash.
*   The helper accepts any byte even though only the documented NIST hash
*   suffixes are meaningful downstream.
* @returns Object containing the DER-encoded OID.
* @example
* Build OID metadata for a NIST hash.
* ```ts
* oidNist(0x01);
* ```
*/
var oidNist = (suffix) => ({ oid: Uint8Array.from([
	6,
	9,
	96,
	134,
	72,
	1,
	101,
	3,
	4,
	2,
	suffix
]) });
//#endregion
//#region node_modules/@noble/hashes/_md.js
/**
* Internal Merkle-Damgard hash utils.
* @module
*/
/**
* Shared 32-bit conditional boolean primitive reused by SHA-256, SHA-1, and MD5 `F`.
* Returns bits from `b` when `a` is set, otherwise from `c`.
* The XOR form is equivalent to MD5's `F(X,Y,Z) = XY v not(X)Z` because the masked terms never
* set the same bit.
* @param a - selector word
* @param b - word chosen when selector bit is set
* @param c - word chosen when selector bit is clear
* @returns Mixed 32-bit word.
* @example
* Combine three words with the shared 32-bit choice primitive.
* ```ts
* Chi(0xffffffff, 0x12345678, 0x87654321);
* ```
*/
function Chi(a, b, c) {
	return a & b ^ ~a & c;
}
/**
* Shared 32-bit majority primitive reused by SHA-256 and SHA-1.
* Returns bits shared by at least two inputs.
* @param a - first input word
* @param b - second input word
* @param c - third input word
* @returns Mixed 32-bit word.
* @example
* Combine three words with the shared 32-bit majority primitive.
* ```ts
* Maj(0xffffffff, 0x12345678, 0x87654321);
* ```
*/
function Maj(a, b, c) {
	return a & b ^ a & c ^ b & c;
}
/**
* Merkle-Damgard hash construction base class.
* Could be used to create MD5, RIPEMD, SHA1, SHA2.
* Accepts only byte-aligned `Uint8Array` input, even when the underlying spec describes bit
* strings with partial-byte tails.
* @param blockLen - internal block size in bytes
* @param outputLen - digest size in bytes
* @param padOffset - trailing length field size in bytes
* @param isLE - whether length and state words are encoded in little-endian
* @example
* Use a concrete subclass to get the shared Merkle-Damgard update/digest flow.
* ```ts
* import { _SHA1 } from '@noble/hashes/legacy.js';
* const hash = new _SHA1();
* hash.update(new Uint8Array([97, 98, 99]));
* hash.digest();
* ```
*/
var HashMD = class {
	blockLen;
	outputLen;
	canXOF = false;
	padOffset;
	isLE;
	buffer;
	view;
	finished = false;
	length = 0;
	pos = 0;
	destroyed = false;
	constructor(blockLen, outputLen, padOffset, isLE) {
		this.blockLen = blockLen;
		this.outputLen = outputLen;
		this.padOffset = padOffset;
		this.isLE = isLE;
		this.buffer = new Uint8Array(blockLen);
		this.view = createView(this.buffer);
	}
	update(data) {
		aexists(this);
		abytes(data);
		const { view, buffer, blockLen } = this;
		const len = data.length;
		let processed = false;
		for (let pos = 0; pos < len;) {
			const take = Math.min(blockLen - this.pos, len - pos);
			if (take === blockLen) {
				const dataView = createView(data);
				for (; blockLen <= len - pos; pos += blockLen) this.process(dataView, pos);
				processed = true;
				continue;
			}
			buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
			this.pos += take;
			pos += take;
			if (this.pos === blockLen) {
				this.process(view, 0);
				this.pos = 0;
				processed = true;
			}
		}
		this.length += data.length;
		if (processed) this.roundClean();
		return this;
	}
	digestInto(out) {
		aexists(this);
		aoutput(out, this);
		this.finished = true;
		const { buffer, view, blockLen, isLE } = this;
		let { pos } = this;
		buffer[pos++] = 128;
		buffer.fill(0, pos);
		if (this.padOffset > blockLen - pos) {
			this.process(view, 0);
			buffer.fill(0);
		}
		setU64FromNum(view, blockLen - 8, this.length * 8, isLE);
		this.process(view, 0);
		this.roundClean();
		const oview = out === buffer ? view : createView(out);
		const len = this.outputLen;
		const outLen = len / 4;
		const state = this.get();
		if (len % 4 || outLen > state.length) throw new Error("invalid outputLen");
		for (let i = 0; i < outLen; i++) oview.setUint32(4 * i, state[i], isLE);
	}
	digest() {
		const { buffer, outputLen } = this;
		this.digestInto(buffer);
		const res = buffer.slice(0, outputLen);
		this.destroy();
		return res;
	}
	_cloneIntoMeta(to) {
		const { buffer, length, finished, destroyed, pos } = this;
		to.destroyed = destroyed;
		to.finished = finished;
		to.length = length;
		to.pos = pos;
		if (pos) to.buffer.set(buffer);
		return to;
	}
	clone() {
		return this._cloneInto();
	}
};
/**
* Initial SHA-2 state: fractional parts of square roots of first 16 primes 2..53.
* Check out `test/misc/sha2-gen-iv.js` for recomputation guide.
*/
/** Initial SHA256 state from RFC 6234 §6.1: the first 32 bits of the fractional parts of the
* square roots of the first eight prime numbers. Exported as a shared table; callers must treat
* it as read-only because constructors copy words from it by index. */
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
	1779033703,
	3144134277,
	1013904242,
	2773480762,
	1359893119,
	2600822924,
	528734635,
	1541459225
]);
//#endregion
//#region node_modules/@noble/hashes/sha2.js
/**
* SHA2 hash function. A.k.a. sha256, sha384, sha512, sha512_224, sha512_256.
* SHA256 is the fastest hash implementable in JS, even faster than Blake3.
* Check out {@link https://www.rfc-editor.org/rfc/rfc4634 | RFC 4634} and
* {@link https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf | FIPS 180-4}.
* @module
*/
/**
* SHA-224 / SHA-256 round constants from RFC 6234 §5.1: the first 32 bits
* of the cube roots of the first 64 primes (2..311).
*/
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
	1116352408,
	1899447441,
	3049323471,
	3921009573,
	961987163,
	1508970993,
	2453635748,
	2870763221,
	3624381080,
	310598401,
	607225278,
	1426881987,
	1925078388,
	2162078206,
	2614888103,
	3248222580,
	3835390401,
	4022224774,
	264347078,
	604807628,
	770255983,
	1249150122,
	1555081692,
	1996064986,
	2554220882,
	2821834349,
	2952996808,
	3210313671,
	3336571891,
	3584528711,
	113926993,
	338241895,
	666307205,
	773529912,
	1294757372,
	1396182291,
	1695183700,
	1986661051,
	2177026350,
	2456956037,
	2730485921,
	2820302411,
	3259730800,
	3345764771,
	3516065817,
	3600352804,
	4094571909,
	275423344,
	430227734,
	506948616,
	659060556,
	883997877,
	958139571,
	1322822218,
	1537002063,
	1747873779,
	1955562222,
	2024104815,
	2227730452,
	2361852424,
	2428436474,
	2756734187,
	3204031479,
	3329325298
]);
/** Reusable SHA-224 / SHA-256 message schedule buffer `W_t` from RFC 6234 §6.2 step 1. */
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
/** Internal SHA-224 / SHA-256 compression engine from RFC 6234 §6.2. */
var SHA2_32B = class extends HashMD {
	A = 0;
	B = 0;
	C = 0;
	D = 0;
	E = 0;
	F = 0;
	G = 0;
	H = 0;
	constructor(outputLen, IV) {
		super(64, outputLen, 8, false);
		this.A = IV[0] | 0;
		this.B = IV[1] | 0;
		this.C = IV[2] | 0;
		this.D = IV[3] | 0;
		this.E = IV[4] | 0;
		this.F = IV[5] | 0;
		this.G = IV[6] | 0;
		this.H = IV[7] | 0;
	}
	get() {
		const { A, B, C, D, E, F, G, H } = this;
		return [
			A,
			B,
			C,
			D,
			E,
			F,
			G,
			H
		];
	}
	set(A, B, C, D, E, F, G, H) {
		this.A = A | 0;
		this.B = B | 0;
		this.C = C | 0;
		this.D = D | 0;
		this.E = E | 0;
		this.F = F | 0;
		this.G = G | 0;
		this.H = H | 0;
	}
	_cloneInto(to) {
		(to ||= new this.constructor()).set(...this.get());
		return this._cloneIntoMeta(to);
	}
	process(view, offset) {
		for (let i = 0; i < 16; i++, offset += 4) SHA256_W[i] = view.getUint32(offset, false);
		for (let i = 16; i < 64; i++) {
			const W15 = SHA256_W[i - 15];
			const W2 = SHA256_W[i - 2];
			const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
			const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
			SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
		}
		let { A, B, C, D, E, F, G, H } = this;
		for (let i = 0; i < 64; i++) {
			const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
			const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
			const T2 = (rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22)) + Maj(A, B, C) | 0;
			H = G;
			G = F;
			F = E;
			E = D + T1 | 0;
			D = C;
			C = B;
			B = A;
			A = T1 + T2 | 0;
		}
		A = A + this.A | 0;
		B = B + this.B | 0;
		C = C + this.C | 0;
		D = D + this.D | 0;
		E = E + this.E | 0;
		F = F + this.F | 0;
		G = G + this.G | 0;
		H = H + this.H | 0;
		this.set(A, B, C, D, E, F, G, H);
	}
	roundClean() {
		clean(SHA256_W);
	}
	destroy() {
		this.destroyed = true;
		this.set(0, 0, 0, 0, 0, 0, 0, 0);
		clean(this.buffer);
	}
};
/** Internal SHA-256 hash class grounded in RFC 6234 §6.2. */
var _SHA256 = class extends SHA2_32B {
	constructor() {
		super(32, SHA256_IV);
	}
};
/**
* SHA2-256 hash function from RFC 4634. In JS it's the fastest: even faster than Blake3. Some info:
*
* - Trying 2^128 hashes would get 50% chance of collision, using birthday attack.
* - BTC network is doing 2^70 hashes/sec (2^95 hashes/year) as per 2025.
* - Each sha256 hash is executing 2^18 bit operations.
* - Good 2024 ASICs can do 200Th/sec with 3500 watts of power, corresponding to 2^36 hashes/joule.
* @param msg - message bytes to hash
* @param opts - Reserved hash options.
* @returns Digest bytes.
* @example
* Hash a message with SHA2-256.
* ```ts
* sha256(new Uint8Array([97, 98, 99]));
* ```
*/
var sha256 = /* @__PURE__ */ createHasher(() => new _SHA256(), /* @__PURE__ */ oidNist(1));
//#endregion
//#region packages/core/src/model/validation.ts
var object$1 = (value) => !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
var isQuixiId = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
var entityKinds = [
	"thread",
	"message",
	"generation",
	"part",
	"attachment",
	"document",
	"event"
];
function isJsonValue(value) {
	const ancestors = /* @__PURE__ */ new Set();
	const visit = (item, depth) => {
		if (depth > 128) return false;
		if (item === null || typeof item === "string" || typeof item === "boolean") return true;
		if (typeof item === "number") return Number.isFinite(item);
		if (!Array.isArray(item) && !object$1(item)) return false;
		if (ancestors.has(item)) return false;
		ancestors.add(item);
		const valid = Object.values(item).every((child) => visit(child, depth + 1));
		ancestors.delete(item);
		return valid;
	};
	return visit(value, 0);
}
[...entityKinds], [...entityKinds];
//#endregion
//#region packages/core/src/contracts/serialization.ts
/** Count serialized UTF-8 bytes without constructing the serialized payload. */
function jsonByteLength(value, limit = 1048576) {
	if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid JSON byte limit");
	let bytes = 0;
	const ancestors = /* @__PURE__ */ new Set();
	const add = (count) => {
		bytes += count;
		if (bytes > limit) throw new Error("Boundary payload exceeds byte limit");
	};
	const string = (text) => {
		add(2);
		for (let index = 0; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (code === 34 || code === 92 || [
				8,
				9,
				10,
				12,
				13
			].includes(code)) add(2);
			else if (code < 32) add(6);
			else if (code >= 55296 && code <= 56319) {
				const next = text.charCodeAt(index + 1);
				if (next >= 56320 && next <= 57343) {
					add(4);
					index++;
				} else add(6);
			} else if (code >= 56320 && code <= 57343) add(6);
			else add(code < 128 ? 1 : code < 2048 ? 2 : 3);
		}
	};
	const visit = (item, depth) => {
		if (depth > 128) throw new Error("Boundary JSON nesting exceeds 128");
		if (item === null) {
			add(4);
			return;
		}
		if (typeof item === "string") {
			string(item);
			return;
		}
		if (typeof item === "boolean") {
			add(item ? 4 : 5);
			return;
		}
		if (typeof item === "number" && Number.isFinite(item)) {
			add(String(item).length);
			return;
		}
		if (!item || typeof item !== "object" || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("Boundary payload must be plain finite JSON");
		if (ancestors.has(item)) throw new Error("Boundary payload contains a cycle");
		ancestors.add(item);
		add(2);
		if (Array.isArray(item)) for (let index = 0; index < item.length; index++) {
			if (index) add(1);
			visit(item[index], depth + 1);
		}
		else {
			let count = 0;
			for (const key in item) {
				const descriptor = Object.getOwnPropertyDescriptor(item, key);
				if (!descriptor?.enumerable) continue;
				if (descriptor.get || descriptor.set) throw new Error("Boundary payload cannot contain accessors");
				if (count++) add(1);
				string(key);
				add(1);
				visit(descriptor.value, depth + 1);
			}
		}
		ancestors.delete(item);
	};
	visit(value, 0);
	return bytes;
}
Object.freeze({
	extractorVersion: "quixi-extract-1/pdfjs-6.3.289",
	normalizerVersion: "quixi-layout-2"
});
var EXTRACTION_LIMITS = Object.freeze({
	sourceBytes: 33554432,
	pages: 1e3,
	pageUTF16: 262144,
	pageItems: 1e4,
	stageUTF16: 4096,
	stageSpans: 128,
	stageBytes: 32768,
	pageSpans: 32768,
	pageMapBytes: 4194304,
	pageBatches: 1024,
	runBytes: 268435456,
	archiveBytes: 1073741824,
	textReadUTF16: 16384,
	mapReadSpans: 128,
	mapReadBytes: 65536
});
var ExtractionStorageError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "ExtractionStorageError";
	}
};
var fail$1 = (message) => {
	throw new ExtractionStorageError("INVALID_REQUEST", message);
};
var object = (value) => {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail$1("Expected extraction object.");
	return value;
};
function keys(value, expected) {
	if (Object.keys(value).length !== expected.length || expected.some((k) => !Object.hasOwn(value, k))) fail$1("Unknown or missing extraction field.");
}
var integer = (v, min, max) => {
	if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) fail$1("Extraction integer exceeds its bound.");
};
var id = (v) => {
	if (!isQuixiId(v)) fail$1("Invalid extraction UUID.");
};
var hash = (v) => {
	if (typeof v !== "string" || v.length !== 64 || !/^[0-9a-f]{64}$/.test(v)) fail$1("Invalid extraction digest.");
};
function assertExtractionIdentity(value) {
	const v = object(value);
	keys(v, [
		"documentId",
		"attachmentId",
		"attachmentSha256",
		"attachmentByteLength",
		"extractorVersion",
		"normalizerVersion"
	]);
	id(v.documentId);
	id(v.attachmentId);
	hash(v.attachmentSha256);
	integer(v.attachmentByteLength, 1, EXTRACTION_LIMITS.sourceBytes);
	for (const k of ["extractorVersion", "normalizerVersion"]) if (typeof v[k] !== "string" || !v[k].length || v[k].length > 128) fail$1("Invalid extraction version.");
}
function assertPublishedPageRef(value) {
	const v = object(value);
	keys(v, [
		"pageAttemptId",
		"runId",
		"page",
		"identity",
		"sourceDigest",
		"publicationRevision"
	]);
	id(v.pageAttemptId);
	id(v.runId);
	integer(v.page, 1, 1e3);
	assertExtractionIdentity(v.identity);
	hash(v.sourceDigest);
	integer(v.publicationRevision, 1, Number.MAX_SAFE_INTEGER);
}
function wellFormed(text) {
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c >= 55296 && c <= 56319) {
			const n = text.charCodeAt(++i);
			if (!(n >= 56320 && n <= 57343)) fail$1("Unpaired text surrogate.");
		} else if (c >= 56320 && c <= 57343) fail$1("Unpaired text surrogate.");
	}
}
var fields = {
	getPublishedExtractionPage: ["runId", "page"],
	advanceExtractionPageIndex: ["pageRef"],
	beginDocumentExtraction: ["operationId", "identity"],
	resumeDocumentExtraction: [
		"operationId",
		"runId",
		"expectedWriterEpoch"
	],
	beginExtractionPage: [
		"operationId",
		"runId",
		"writerEpoch",
		"page",
		"documentPageCount"
	],
	stagePageText: [
		"operationId",
		"runId",
		"writerEpoch",
		"pageAttemptId",
		"sequence",
		"expectedUTF16Offset",
		"text",
		"spans"
	],
	publishExtractionPage: [
		"operationId",
		"runId",
		"writerEpoch",
		"pageAttemptId",
		"lastSequence",
		"expectedUTF16Length",
		"expectedTextSha256",
		"expectedMapSha256",
		"itemCount",
		"classification"
	],
	completeDocumentExtraction: [
		"operationId",
		"runId",
		"writerEpoch"
	],
	interruptDocumentExtraction: [
		"operationId",
		"runId",
		"writerEpoch",
		"reason"
	],
	getDocumentExtraction: ["documentId"],
	getExtractionOperation: ["operationId"],
	readExtractedPageText: [
		"pageRef",
		"startUTF16",
		"maxUTF16"
	],
	readExtractedPageMap: [
		"pageRef",
		"startUTF16",
		"endUTF16",
		"maxItems",
		"maxBytes",
		"cursor"
	],
	clearDocumentExtraction: [
		"operationId",
		"documentId",
		"expectedRunId",
		"expectedDocumentRevision"
	]
};
/** Inspect bounded own descriptors before serialization, including array accessors. */
function inspectBoundary(value) {
	let nodes = 0;
	const ancestors = /* @__PURE__ */ new Set();
	const visit = (item, depth) => {
		if (++nodes > 8192 || depth > 32) fail$1("Extraction boundary is too complex.");
		if (!item || typeof item !== "object") return;
		if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)) || ancestors.has(item)) fail$1("Extraction boundary must be acyclic plain data.");
		ancestors.add(item);
		for (const key in item) {
			const descriptor = Object.getOwnPropertyDescriptor(item, key);
			if (!descriptor?.enumerable) continue;
			if (descriptor.get || descriptor.set) fail$1("Extraction boundary cannot contain accessors.");
			visit(descriptor.value, depth + 1);
		}
		ancestors.delete(item);
	};
	visit(value, 0);
}
function assertExtractionArgs(operation, value) {
	inspectBoundary(value);
	try {
		jsonByteLength(value, EXTRACTION_LIMITS.stageBytes);
	} catch {
		fail$1("Extraction envelope exceeds finite JSON bounds.");
	}
	const v = object(value);
	if (!Object.hasOwn(fields, operation)) fail$1("Unknown extraction operation.");
	keys(v, fields[operation]);
	for (const k of [
		"operationId",
		"runId",
		"documentId",
		"pageAttemptId",
		"expectedRunId"
	]) if (Object.hasOwn(v, k)) id(v[k]);
	for (const k of [
		"writerEpoch",
		"expectedWriterEpoch",
		"expectedDocumentRevision"
	]) if (Object.hasOwn(v, k)) integer(v[k], 1, Number.MAX_SAFE_INTEGER);
	if (operation === "beginDocumentExtraction") assertExtractionIdentity(v.identity);
	if (operation === "advanceExtractionPageIndex") assertPublishedPageRef(v.pageRef);
	if (operation === "getPublishedExtractionPage") integer(v.page, 1, 1e3);
	if (operation === "beginExtractionPage") {
		integer(v.page, 1, 1e3);
		integer(v.documentPageCount, 1, 1e3);
		if (Number(v.page) > Number(v.documentPageCount)) fail$1("Page exceeds document count.");
	}
	if (operation === "stagePageText") {
		integer(v.sequence, 0, 1023);
		integer(v.expectedUTF16Offset, 0, 262144);
		if (typeof v.text !== "string" || !v.text.length || v.text.length > 4096) fail$1("Stage text exceeds bound.");
		wellFormed(v.text);
		if (!Array.isArray(v.spans) || !v.spans.length || v.spans.length > 128) fail$1("Stage maps exceed bound.");
		let at = Number(v.expectedUTF16Offset);
		for (const item of v.spans) {
			const s = object(item);
			keys(s, [
				"start",
				"end",
				"source"
			]);
			integer(s.start, 0, 262144);
			integer(s.end, 1, 262144);
			if (s.start !== at || Number(s.end) <= at) fail$1("Maps must cover the stage contiguously.");
			at = Number(s.end);
			const relativeEnd = at - Number(v.expectedUTF16Offset);
			if (relativeEnd > 0 && relativeEnd < v.text.length) {
				const previous = v.text.charCodeAt(relativeEnd - 1);
				const next = v.text.charCodeAt(relativeEnd);
				if (previous >= 55296 && previous <= 56319 && next >= 56320 && next <= 57343) fail$1("Source map splits a surrogate pair.");
			}
			if (s.source !== null) {
				const p = object(s.source);
				keys(p, [
					"itemIndex",
					"itemStart",
					"itemEnd",
					"transform",
					"width",
					"height",
					"direction"
				]);
				integer(p.itemIndex, 0, 9999);
				integer(p.itemStart, 0, 262144);
				integer(p.itemEnd, 1, 262144);
				if (Number(p.itemEnd) - Number(p.itemStart) !== Number(s.end) - Number(s.start)) fail$1("Source span differs from copied text.");
				if (!Array.isArray(p.transform) || p.transform.length !== 6 || ![
					...p.transform,
					p.width,
					p.height
				].every((n) => typeof n === "number" && Number.isFinite(n)) || ![
					"ltr",
					"rtl",
					"ttb"
				].includes(String(p.direction))) fail$1("Invalid source layout.");
			}
		}
		if (at !== Number(v.expectedUTF16Offset) + v.text.length) fail$1("Maps do not cover the stage text.");
	}
	if (operation === "publishExtractionPage") {
		integer(v.lastSequence, -1, 1023);
		integer(v.expectedUTF16Length, 0, 262144);
		integer(v.itemCount, 0, 1e4);
		hash(v.expectedTextSha256);
		hash(v.expectedMapSha256);
		if (!["text", "possible_scanned"].includes(String(v.classification))) fail$1("Invalid page classification.");
	}
	if (operation === "interruptDocumentExtraction" && ![
		"user_cancelled",
		"parser_failed",
		"password_required",
		"source_unavailable",
		"capacity",
		"confirmed_producer_loss"
	].includes(String(v.reason))) fail$1("Invalid interruption reason.");
	if (operation === "readExtractedPageText" || operation === "readExtractedPageMap") {
		assertPublishedPageRef(v.pageRef);
		integer(v.startUTF16, 0, 262144);
	}
	if (operation === "readExtractedPageText") integer(v.maxUTF16, 1, 16384);
	if (operation === "readExtractedPageMap") {
		integer(v.endUTF16, Number(v.startUTF16), 262144);
		integer(v.maxItems, 1, 128);
		integer(v.maxBytes, 256, 65536);
		if (v.cursor !== null && (typeof v.cursor !== "string" || v.cursor.length > 1024)) fail$1("Invalid map cursor.");
	}
}
Object.freeze({
	chunkBytes: 65536,
	maxInFlight: 4,
	maxActiveJobs: 2,
	maxRecordsPerStep: 128,
	maxBytesPerStep: 1048576,
	maxMetadataBytes: 65536,
	maxEntryBytes: Number.MAX_SAFE_INTEGER,
	maxEntries: 1e6
});
Object.freeze({
	maxItems: 128,
	maxMetadataBytes: 65536,
	maxKeyCharacters: 8192
});
Object.freeze({
	maxRecordsPerRequest: 128,
	maxRecordBytes: 262144,
	maxActiveJobs: 8
});
//#endregion
//#region packages/core/src/contracts/transfer.ts
var MAX_TRANSFER_BYTES = 1048576;
//#endregion
//#region packages/core/src/contracts/storage.ts
/** Stable payload comparison for operation-ID idempotency; not an encryption/hash format. */
function canonicalJson(value) {
	if (!isJsonValue(value)) throw new Error("Value is not serializable JSON");
	const visit = (item) => {
		if (Array.isArray(item)) return `[${item.map(visit).join(",")}]`;
		if (item && typeof item === "object") return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${visit(item[key])}`).join(",")}}`;
		return JSON.stringify(item);
	};
	return visit(value);
}
Object.freeze({
	maxRequestBytes: MAX_TRANSFER_BYTES,
	maxResponseBytes: MAX_TRANSFER_BYTES,
	maxPendingRequests: 64,
	maxBatchMutations: 128,
	maxPageItems: 1e3
});
Object.freeze({
	maxSecretBytes: 16384,
	maxSelectedFiles: 256,
	maxTimeoutMs: 36e5
});
//#endregion
//#region packages/storage/src/worker/extraction/schema.ts
var EXTRACTION_SCHEMA = `
CREATE TABLE quixi_extract_schema(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL) STRICT;
CREATE TABLE quixi_extract_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,used_bytes INTEGER NOT NULL CHECK(used_bytes>=0)) STRICT;
CREATE TABLE quixi_extract_documents(document_id TEXT PRIMARY KEY,latest_run TEXT NOT NULL,visible_run TEXT,revision INTEGER NOT NULL) STRICT;
CREATE TABLE quixi_extract_runs(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,identity TEXT NOT NULL,state TEXT NOT NULL,writer_epoch INTEGER NOT NULL,page_count INTEGER,completed_page INTEGER NOT NULL,current_page TEXT,used_bytes INTEGER NOT NULL CHECK(used_bytes>=0),failure TEXT) STRICT;
CREATE INDEX quixi_extract_run_document ON quixi_extract_runs(document_id,id);
CREATE INDEX quixi_extract_run_state ON quixi_extract_runs(state,id);
CREATE TABLE quixi_extract_pages(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,page INTEGER NOT NULL,state TEXT NOT NULL,next_sequence INTEGER NOT NULL,utf16 INTEGER NOT NULL,map_count INTEGER NOT NULL,map_bytes INTEGER NOT NULL,max_item INTEGER NOT NULL,text TEXT,text_sha TEXT,map_sha TEXT,source_digest TEXT,publication_revision INTEGER,classification TEXT,published_bytes INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE INDEX quixi_extract_page_run ON quixi_extract_pages(run_id,page,id);
CREATE INDEX quixi_extract_page_cursor ON quixi_extract_pages(run_id,id);
CREATE UNIQUE INDEX quixi_extract_published_page ON quixi_extract_pages(run_id,page) WHERE state='published';
CREATE TABLE quixi_extract_text_batches(page_id TEXT NOT NULL,sequence INTEGER NOT NULL,start_utf16 INTEGER NOT NULL,text TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(page_id,sequence)) STRICT;
CREATE TABLE quixi_extract_map_batches(page_id TEXT NOT NULL,sequence INTEGER NOT NULL,start_utf16 INTEGER NOT NULL,end_utf16 INTEGER NOT NULL,maps TEXT NOT NULL,map_digest TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(page_id,sequence)) STRICT;
CREATE INDEX quixi_extract_map_range ON quixi_extract_map_batches(page_id,end_utf16,sequence);
CREATE TABLE quixi_extract_operations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,digest TEXT NOT NULL,run_id TEXT,result TEXT NOT NULL,bytes INTEGER NOT NULL) STRICT;
CREATE TABLE quixi_extract_cleanup_pages(page_id TEXT PRIMARY KEY) STRICT;
CREATE TABLE quixi_extract_cleanup_runs(run_id TEXT PRIMARY KEY,after_id TEXT NOT NULL) STRICT;
CREATE TABLE quixi_extract_publications(revision INTEGER PRIMARY KEY,document_id TEXT NOT NULL,run_id TEXT NOT NULL,page_id TEXT,kind TEXT NOT NULL) STRICT;
`;
//#endregion
//#region packages/storage/src/worker/extraction/index.ts
var json = (value) => canonicalJson(value);
var extractionDigest = (value) => bytesToHex(sha256(new TextEncoder().encode(json(value))));
var extractionTextDigest = (value) => bytesToHex(sha256(new TextEncoder().encode(value)));
function extractionMapDigest(spans) {
	const hash = sha256.create();
	for (const span of spans) hash.update(new TextEncoder().encode(json(span) + "\n"));
	return bytesToHex(hash.digest());
}
var fail = (code, message) => {
	throw new ExtractionStorageError(code, message);
};
var schemaDigest = extractionTextDigest(EXTRACTION_SCHEMA);
var readJSON = (v) => JSON.parse(String(v));
/** Synchronous, owner-serialized derived repository; never executes caller SQL. */
var ExtractionRepository = class {
	db;
	options;
	initialized = false;
	closed = false;
	controlAdmission = false;
	runLimit;
	archiveLimit;
	publishedSources;
	constructor(db, options) {
		this.db = db;
		this.options = options;
		this.runLimit = options.limits?.runBytes ?? EXTRACTION_LIMITS.runBytes;
		this.archiveLimit = options.limits?.archiveBytes ?? EXTRACTION_LIMITS.archiveBytes;
		if (!Number.isSafeInteger(this.runLimit) || this.runLimit < 1 || this.runLimit > EXTRACTION_LIMITS.runBytes || !Number.isSafeInteger(this.archiveLimit) || this.archiveLimit < 1 || this.archiveLimit > EXTRACTION_LIMITS.archiveBytes) fail("INVALID_REQUEST", "Invalid logical extraction budget.");
		this.publishedSources = {
			ready: () => this.initialized && !this.closed,
			listVisiblePages: (doc, after, limit) => this.listVisiblePages(doc, after, limit),
			loadPage: (id) => this.loadPage(id),
			current: (ref) => this.current(ref),
			readPublicationBatch: (limit) => this.publications(limit),
			acknowledgePublications: (ids) => this.acknowledge(ids)
		};
	}
	rows(sql, bind = []) {
		return this.db.exec({
			sql,
			...bind.length ? { bind } : {},
			rowMode: "object",
			returnValue: "resultRows"
		});
	}
	exec(sql, bind = []) {
		this.db.exec({
			sql,
			...bind.length ? { bind } : {}
		});
	}
	one(sql, bind = []) {
		return this.rows(sql, bind)[0];
	}
	tx(work) {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = work();
			this.options.beforeCommit?.();
			this.db.exec("COMMIT");
			return result;
		} catch (e) {
			try {
				this.db.exec("ROLLBACK");
			} catch {}
			if (/SQLITE_FULL|database or disk is full/i.test(String(e))) fail("CAPACITY", "Extraction storage is full; committed pages are retained.");
			throw e;
		}
	}
	initialize() {
		if (this.closed) fail("CONFLICT", "Extraction repository is closed.");
		if (!this.rows("SELECT name,sql FROM sqlite_schema WHERE (name GLOB 'quixi_extract_*' OR tbl_name GLOB 'quixi_extract_*') AND sql IS NOT NULL AND type IN('table','index','trigger','view')").length) this.tx(() => {
			this.db.exec(EXTRACTION_SCHEMA);
			this.exec("INSERT INTO quixi_extract_schema VALUES(?,?)", [1, schemaDigest]);
			this.exec("INSERT INTO quixi_extract_meta VALUES(1,0,0)");
		});
		const objects = EXTRACTION_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);
		const actual = this.rows("SELECT name,sql FROM sqlite_schema WHERE (name GLOB 'quixi_extract_*' OR tbl_name GLOB 'quixi_extract_*') AND sql IS NOT NULL AND type IN('table','index','trigger','view')");
		if (actual.length !== objects.length || objects.some((sql) => !actual.some((row) => String(row.sql).replace(/\s+/g, " ").trim() === sql.replace(/\s+/g, " ").trim()))) fail("MIGRATION_FAILED", "Extraction schema differs; isolate and explicitly repair derived extraction.");
		const ledger = this.rows("SELECT * FROM quixi_extract_schema");
		if (ledger.length !== 1 || ledger[0].version !== 1 || ledger[0].checksum !== schemaDigest) fail("MIGRATION_FAILED", "Unsupported extraction schema ledger.");
		this.initialized = true;
	}
	close() {
		this.closed = true;
		this.initialized = false;
	}
	check() {
		if (!this.initialized || this.closed) fail("MIGRATION_FAILED", "Extraction repository is unavailable; canonical data is unaffected.");
	}
	run(id) {
		return this.one("SELECT * FROM quixi_extract_runs WHERE id=?", [id]) ?? fail("NOT_FOUND", "Extraction run not found.");
	}
	document(id) {
		return this.one("SELECT * FROM quixi_extract_documents WHERE document_id=?", [id]) ?? fail("NOT_FOUND", "Extraction document not found.");
	}
	identity(run) {
		const value = readJSON(run.identity);
		assertExtractionIdentity(value);
		return value;
	}
	assertIdentity(identity) {
		const current = this.options.lookupIdentity(identity.documentId);
		if (!current || !current.available || current.documentId !== identity.documentId || current.attachmentId !== identity.attachmentId || current.attachmentSha256 !== identity.attachmentSha256 || current.attachmentByteLength !== identity.attachmentByteLength || current.mediaType.split(";")[0].trim().toLowerCase() !== "application/pdf") fail("SOURCE_UNAVAILABLE", "Original document attachment identity is unavailable or changed.");
	}
	write(value, checkIdentity = true) {
		const run = this.run(value.runId);
		if (run.writer_epoch !== value.writerEpoch) fail("STALE_WRITER", "Extraction writer was superseded.");
		if (run.state !== "working" || this.document(String(run.document_id)).latest_run !== run.id) fail("CONFLICT", "Run is not the current working extraction.");
		if (checkIdentity) this.assertIdentity(this.identity(run));
		return run;
	}
	page(value) {
		const run = this.write(value);
		const page = this.one("SELECT id,run_id,page,state,next_sequence,utf16,map_count,map_bytes,max_item,text_sha,map_sha,source_digest,publication_revision,classification,published_bytes FROM quixi_extract_pages WHERE id=? AND run_id=?", [value.pageAttemptId, value.runId]);
		if (!page || page.state !== "staging" || run.current_page !== page.id) fail("CONFLICT", "Page attempt is not the current unpublished page.");
		return {
			run,
			page
		};
	}
	charge(runId, delta) {
		const run = this.run(runId), meta = this.one("SELECT used_bytes FROM quixi_extract_meta");
		if (Number(run.used_bytes) + delta < 0 || Number(meta.used_bytes) + delta < 0) fail("MIGRATION_FAILED", "Derived byte accounting is inconsistent.");
		const runBudget = this.runLimit - (this.controlAdmission || delta < 0 ? 0 : Math.min(65536, Math.floor(this.runLimit / 4))), archiveBudget = this.archiveLimit - (this.controlAdmission || delta < 0 ? 0 : Math.min(1048576, Math.floor(this.archiveLimit / 4)));
		if (Number(run.used_bytes) + delta > runBudget || Number(meta.used_bytes) + delta > archiveBudget) fail("CAPACITY", "Logical extraction budget exceeded; committed pages are retained.");
		this.exec("UPDATE quixi_extract_runs SET used_bytes=used_bytes+? WHERE id=?", [delta, runId]);
		this.exec("UPDATE quixi_extract_meta SET used_bytes=used_bytes+?", [delta]);
	}
	revision() {
		this.exec("UPDATE quixi_extract_meta SET revision=revision+1");
		const n = Number(this.one("SELECT revision FROM quixi_extract_meta").revision);
		if (!Number.isSafeInteger(n)) fail("CAPACITY", "Extraction revision exhausted.");
		return n;
	}
	publishNotice(run, pageId, kind) {
		const revision = this.revision();
		this.exec("INSERT INTO quixi_extract_publications VALUES(?,?,?,?,?)", [
			revision,
			String(run.document_id),
			String(run.id),
			pageId,
			kind
		]);
		this.charge(String(run.id), 256);
		return revision;
	}
	pageStatus(page) {
		return {
			pageAttemptId: String(page.id),
			page: Number(page.page),
			nextSequence: Number(page.next_sequence),
			utf16: Number(page.utf16),
			mapCount: Number(page.map_count)
		};
	}
	status(runId) {
		const run = this.run(runId), doc = this.document(String(run.document_id));
		const page = run.current_page ? this.one("SELECT id,run_id,page,state,next_sequence,utf16,map_count,map_bytes,max_item,text_sha,map_sha,source_digest,publication_revision,classification,published_bytes FROM quixi_extract_pages WHERE id=?", [run.current_page]) : null;
		return {
			runId,
			identity: this.identity(run),
			state: run.state,
			writerEpoch: Number(run.writer_epoch),
			pageCount: run.page_count === null ? null : Number(run.page_count),
			completedPage: Number(run.completed_page),
			currentPage: page ? this.pageStatus(page) : null,
			visibleRunId: doc.visible_run === null ? null : String(doc.visible_run),
			documentRevision: Number(doc.revision),
			retainedBytes: Number(run.used_bytes),
			failure: run.failure === null ? null : String(run.failure)
		};
	}
	operationStatus(operationId) {
		this.check();
		if (!isQuixiId(operationId)) fail("INVALID_REQUEST", "Invalid operation identity.");
		const row = this.one("SELECT digest,result FROM quixi_extract_operations WHERE id=?", [operationId]);
		return row ? {
			status: "committed",
			requestDigest: String(row.digest),
			result: readJSON(row.result)
		} : { status: "not_found" };
	}
	execute(operation, input) {
		this.check();
		assertExtractionArgs(operation, input);
		const args = JSON.parse(json(input));
		if (operation === "getPublishedExtractionPage") {
			const { runId, page: pageNumber } = args;
			const page = this.one("SELECT id,run_id,page,source_digest,publication_revision FROM quixi_extract_pages WHERE run_id=? AND page=? AND state='published'", [runId, pageNumber]);
			if (!page) return null;
			const ref = this.ref(page, this.run(runId));
			return this.current(ref) ? ref : null;
		}
		if (operation === "getExtractionOperation") return this.operationStatus(args.operationId);
		if (operation === "getDocumentExtraction") {
			const doc = this.one("SELECT latest_run FROM quixi_extract_documents WHERE document_id=?", [args.documentId]);
			return doc ? this.status(String(doc.latest_run)) : null;
		}
		if (operation === "readExtractedPageText") return this.readText(args);
		if (operation === "readExtractedPageMap") return this.readMaps(args);
		const operationId = args.operationId, digest = extractionDigest({
			operation,
			args
		});
		const previous = this.one("SELECT kind,digest,result FROM quixi_extract_operations WHERE id=?", [operationId]);
		if (previous) {
			if (previous.kind !== operation || previous.digest !== digest) fail("CONFLICT", "Operation ID describes a different extraction request.");
			return readJSON(previous.result);
		}
		this.controlAdmission = operation === "clearDocumentExtraction" || operation === "interruptDocumentExtraction";
		try {
			return this.tx(() => {
				this.options.operations.claim({
					operationId,
					domain: "extraction",
					requestDigest: digest
				});
				let result;
				let runId;
				switch (operation) {
					case "beginDocumentExtraction":
						result = this.begin(args);
						runId = operationId;
						break;
					case "resumeDocumentExtraction":
						result = this.resume(args);
						runId = args.runId;
						break;
					case "beginExtractionPage":
						result = this.beginPage(args);
						runId = args.runId;
						break;
					case "stagePageText":
						result = this.stage(args);
						runId = args.runId;
						break;
					case "publishExtractionPage":
						result = this.publish(args);
						runId = args.runId;
						break;
					case "completeDocumentExtraction":
						result = this.complete(args);
						runId = args.runId;
						break;
					case "interruptDocumentExtraction":
						result = this.interrupt(args);
						runId = args.runId;
						break;
					case "clearDocumentExtraction": {
						const a = args;
						result = this.clear(a);
						runId = a.expectedRunId;
						break;
					}
					default: return fail("INVALID_REQUEST", "Unsupported extraction operation.");
				}
				const receiptBytes = jsonByteLength(result, 16384) + 512;
				this.charge(runId, receiptBytes);
				if (result && typeof result === "object" && "retainedBytes" in result) result.retainedBytes = Number(this.run(runId).used_bytes);
				this.exec("INSERT INTO quixi_extract_operations VALUES(?,?,?,?,?,?)", [
					operationId,
					operation,
					digest,
					runId,
					json(result),
					receiptBytes
				]);
				return result;
			});
		} finally {
			this.controlAdmission = false;
		}
	}
	begin(a) {
		this.assertIdentity(a.identity);
		if (!this.options.supportedVersions.some((v) => v.extractorVersion === a.identity.extractorVersion && v.normalizerVersion === a.identity.normalizerVersion)) fail("INVALID_REQUEST", "Extractor/normalizer version is not registered.");
		if (this.one("SELECT id FROM quixi_extract_runs WHERE state='working' LIMIT 1")) fail("OVERLOADED", "One extraction is already working; interrupt or resume it first.");
		const doc = this.one("SELECT * FROM quixi_extract_documents WHERE document_id=?", [a.identity.documentId]);
		this.exec("INSERT INTO quixi_extract_runs VALUES(?,?,?,'working',1,NULL,0,NULL,0,NULL)", [
			a.operationId,
			a.identity.documentId,
			json(a.identity)
		]);
		if (doc) this.exec("UPDATE quixi_extract_documents SET latest_run=?,revision=revision+1 WHERE document_id=?", [a.operationId, a.identity.documentId]);
		else this.exec("INSERT INTO quixi_extract_documents VALUES(?,?,NULL,1)", [a.identity.documentId, a.operationId]);
		if (doc && doc.latest_run !== doc.visible_run) this.queueRun(String(doc.latest_run));
		this.charge(a.operationId, 1024 + jsonByteLength(a.identity));
		return this.status(a.operationId);
	}
	queuePage(id) {
		this.exec("INSERT OR IGNORE INTO quixi_extract_cleanup_pages VALUES(?)", [id]);
	}
	queueRun(id) {
		this.exec("INSERT OR IGNORE INTO quixi_extract_cleanup_runs VALUES(?,'')", [id]);
	}
	abandon(run) {
		if (run.current_page) {
			this.queuePage(String(run.current_page));
			this.exec("UPDATE quixi_extract_pages SET state='abandoned' WHERE id=? AND state='staging'", [run.current_page]);
		}
		this.exec("UPDATE quixi_extract_runs SET current_page=NULL WHERE id=?", [run.id]);
	}
	resume(a) {
		const run = this.run(a.runId);
		if (run.writer_epoch !== a.expectedWriterEpoch) fail("STALE_WRITER", "Writer epoch changed before claim.");
		if (!["working", "interrupted"].includes(String(run.state)) || this.document(String(run.document_id)).latest_run !== run.id) fail("CONFLICT", "Only the latest resumable run may be claimed.");
		this.assertIdentity(this.identity(run));
		if (this.one("SELECT id FROM quixi_extract_runs WHERE state='working' AND id<>? LIMIT 1", [a.runId])) fail("OVERLOADED", "Another document extraction is working.");
		if (a.expectedWriterEpoch >= Number.MAX_SAFE_INTEGER) fail("CAPACITY", "Writer epoch exhausted.");
		this.abandon(run);
		this.exec("UPDATE quixi_extract_runs SET writer_epoch=writer_epoch+1,state='working',failure=NULL WHERE id=?", [a.runId]);
		return this.status(a.runId);
	}
	beginPage(a) {
		const run = this.write(a);
		if (run.current_page || a.page !== Number(run.completed_page) + 1 || run.page_count !== null && run.page_count !== a.documentPageCount) fail("CONFLICT", "Page is not the next contiguous page or count changed.");
		if (this.one("SELECT id FROM quixi_extract_pages WHERE run_id=? AND state='abandoned' LIMIT 1", [a.runId])) fail("OVERLOADED", "Clean abandoned page work before another attempt.");
		this.exec("INSERT INTO quixi_extract_pages(id,run_id,page,state,next_sequence,utf16,map_count,map_bytes,max_item) VALUES(?,?,?,'staging',0,0,0,0,-1)", [
			a.operationId,
			a.runId,
			a.page
		]);
		this.exec("UPDATE quixi_extract_runs SET current_page=?,page_count=? WHERE id=?", [
			a.operationId,
			a.documentPageCount,
			a.runId
		]);
		this.charge(a.runId, 512);
		return this.pageStatus(this.one("SELECT id,run_id,page,state,next_sequence,utf16,map_count,map_bytes,max_item,text_sha,map_sha,source_digest,publication_revision,classification,published_bytes FROM quixi_extract_pages WHERE id=?", [a.operationId]));
	}
	stage(a) {
		const { page } = this.page(a);
		if (page.next_sequence !== a.sequence || page.utf16 !== a.expectedUTF16Offset) fail("CONFLICT", "Stage sequence or committed offset changed.");
		const maps = json(a.spans), mapBytes = new TextEncoder().encode(maps).length, textBytes = new TextEncoder().encode(a.text).length;
		if (Number(page.utf16) + a.text.length > EXTRACTION_LIMITS.pageUTF16 || Number(page.map_count) + a.spans.length > EXTRACTION_LIMITS.pageSpans || Number(page.map_bytes) + mapBytes > EXTRACTION_LIMITS.pageMapBytes) fail("CAPACITY", "Page text or mapping budget exceeded.");
		this.exec("INSERT INTO quixi_extract_text_batches VALUES(?,?,?,?,?)", [
			a.pageAttemptId,
			a.sequence,
			a.expectedUTF16Offset,
			a.text,
			textBytes + 128
		]);
		this.exec("INSERT INTO quixi_extract_map_batches VALUES(?,?,?,?,?,?,?)", [
			a.pageAttemptId,
			a.sequence,
			a.expectedUTF16Offset,
			a.expectedUTF16Offset + a.text.length,
			maps,
			extractionTextDigest(maps),
			mapBytes + 128
		]);
		const maxItem = Math.max(Number(page.max_item), ...a.spans.map((span) => span.source?.itemIndex ?? -1));
		this.exec("UPDATE quixi_extract_pages SET next_sequence=next_sequence+1,utf16=utf16+?,map_count=map_count+?,map_bytes=map_bytes+?,max_item=? WHERE id=?", [
			a.text.length,
			a.spans.length,
			mapBytes,
			maxItem,
			a.pageAttemptId
		]);
		this.charge(a.runId, textBytes + mapBytes + 256);
		return {
			pageAttemptId: a.pageAttemptId,
			sequence: a.sequence,
			committedUTF16Offset: a.expectedUTF16Offset + a.text.length,
			committedMapCount: Number(page.map_count) + a.spans.length
		};
	}
	publish(a) {
		const { run, page } = this.page(a);
		if (Number(page.next_sequence) !== a.lastSequence + 1 || page.utf16 !== a.expectedUTF16Length || Number(page.max_item) >= a.itemCount) fail("CONFLICT", "Final page counters or source item count differ.");
		const textHash = sha256.create(), mapHash = sha256.create(), fragments = [];
		let sequence = 0, units = 0, mapCount = 0, after = -1;
		while (true) {
			const batch = this.rows("SELECT t.sequence,t.start_utf16,json_quote(t.text) AS text_json,m.maps,m.map_digest FROM quixi_extract_text_batches t JOIN quixi_extract_map_batches m ON m.page_id=t.page_id AND m.sequence=t.sequence WHERE t.page_id=? AND t.sequence>? ORDER BY t.sequence LIMIT 32", [a.pageAttemptId, after]);
			if (!batch.length) break;
			for (const row of batch) {
				if (row.sequence !== sequence || row.start_utf16 !== units || sequence >= EXTRACTION_LIMITS.pageBatches) fail("CONFLICT", "Staged page is discontinuous.");
				const text = readJSON(row.text_json), maps = this.checkedMaps(row);
				fragments.push(text);
				textHash.update(new TextEncoder().encode(text));
				let mapOffset = units;
				for (const span of maps) {
					if (span.start !== mapOffset || span.end <= span.start) fail("CONFLICT", "Stored page map is discontinuous.");
					mapOffset = span.end;
					mapHash.update(new TextEncoder().encode(json(span) + "\n"));
					mapCount++;
				}
				units += text.length;
				if (mapOffset !== units || units > EXTRACTION_LIMITS.pageUTF16 || mapCount > EXTRACTION_LIMITS.pageSpans) fail("CAPACITY", "Final page exceeds admitted bounds.");
				sequence++;
				after = Number(row.sequence);
			}
		}
		const textSha = bytesToHex(textHash.digest()), mapSha = bytesToHex(mapHash.digest());
		if (sequence !== a.lastSequence + 1 || units !== a.expectedUTF16Length || mapCount !== page.map_count || textSha !== a.expectedTextSha256 || mapSha !== a.expectedMapSha256) fail("CONFLICT", "Final source text/maps do not match their committed digest.");
		this.assertIdentity(this.identity(run));
		const text = fragments.join(""), identity = this.identity(run);
		const sourceDigest = extractionDigest({
			version: 1,
			identity,
			page: Number(page.page),
			textSha256: textSha,
			mapSha256: mapSha
		});
		const doc = this.document(identity.documentId), kind = doc.visible_run === a.runId ? "page" : "replace";
		if (kind === "replace") {
			if (doc.visible_run) this.queueRun(String(doc.visible_run));
			this.exec("UPDATE quixi_extract_documents SET visible_run=?,revision=revision+1 WHERE document_id=?", [a.runId, identity.documentId]);
		}
		const revision = this.publishNotice(run, a.pageAttemptId, kind), publishedBytes = new TextEncoder().encode(text).length;
		this.exec("UPDATE quixi_extract_pages SET state='published',text=?,text_sha=?,map_sha=?,source_digest=?,publication_revision=?,classification=?,published_bytes=? WHERE id=?", [
			text,
			textSha,
			mapSha,
			sourceDigest,
			revision,
			a.classification,
			publishedBytes,
			a.pageAttemptId
		]);
		this.exec("UPDATE quixi_extract_runs SET completed_page=?,current_page=NULL WHERE id=?", [page.page, a.runId]);
		this.charge(a.runId, publishedBytes);
		this.queuePage(a.pageAttemptId);
		return {
			pageRef: {
				pageAttemptId: a.pageAttemptId,
				runId: a.runId,
				page: Number(page.page),
				identity,
				sourceDigest,
				publicationRevision: revision
			},
			completedPage: Number(page.page)
		};
	}
	complete(a) {
		const run = this.write(a);
		if (run.current_page || run.page_count === null || run.completed_page !== run.page_count) fail("CONFLICT", "All pages must be durably published before completion.");
		this.exec("UPDATE quixi_extract_runs SET state='completed' WHERE id=?", [a.runId]);
		return this.status(a.runId);
	}
	interrupt(a) {
		const run = this.write(a, false);
		this.abandon(run);
		this.exec("UPDATE quixi_extract_runs SET state='interrupted',failure=? WHERE id=?", [a.reason, a.runId]);
		return this.status(a.runId);
	}
	clear(a) {
		const doc = this.document(a.documentId);
		if (doc.latest_run !== a.expectedRunId || doc.revision !== a.expectedDocumentRevision) fail("CONFLICT", "Extraction selection changed before clear.");
		const run = this.run(a.expectedRunId);
		this.abandon(run);
		this.queueRun(a.expectedRunId);
		if (doc.visible_run && doc.visible_run !== a.expectedRunId) this.queueRun(String(doc.visible_run));
		this.exec("UPDATE quixi_extract_runs SET state='cleared',writer_epoch=writer_epoch+1,failure=NULL WHERE id=?", [a.expectedRunId]);
		this.exec("UPDATE quixi_extract_documents SET visible_run=NULL,revision=revision+1 WHERE document_id=?", [a.documentId]);
		this.publishNotice(run, null, "clear");
		return {
			documentId: a.documentId,
			documentRevision: Number(doc.revision) + 1,
			cleared: true
		};
	}
	ref(page, run) {
		return {
			pageAttemptId: String(page.id),
			runId: String(run.id),
			page: Number(page.page),
			identity: this.identity(run),
			sourceDigest: String(page.source_digest),
			publicationRevision: Number(page.publication_revision)
		};
	}
	current(ref) {
		this.check();
		assertPublishedPageRef(ref);
		const page = this.one("SELECT id,run_id,page,state,next_sequence,utf16,map_count,map_bytes,max_item,text_sha,map_sha,source_digest,publication_revision,classification,published_bytes FROM quixi_extract_pages WHERE id=? AND state='published'", [ref.pageAttemptId]);
		if (!page) return false;
		const run = this.run(String(page.run_id));
		if (this.document(String(run.document_id)).visible_run !== run.id || json(this.ref(page, run)) !== json(ref)) return false;
		try {
			this.assertIdentity(ref.identity);
			return true;
		} catch (e) {
			if (e instanceof ExtractionStorageError && e.code === "SOURCE_UNAVAILABLE") return false;
			throw e;
		}
	}
	requireCurrent(ref) {
		if (!this.current(ref)) fail("CONFLICT", "Extracted page reference is stale or unavailable.");
	}
	loadPage(pageId) {
		this.check();
		if (!isQuixiId(pageId)) fail("INVALID_REQUEST", "Invalid page identity.");
		const page = this.one("SELECT id,run_id,page,state,next_sequence,utf16,map_count,map_bytes,max_item,text_sha,map_sha,source_digest,publication_revision,classification,published_bytes FROM quixi_extract_pages WHERE id=? AND state='published'", [pageId]);
		if (!page) return null;
		const ref = this.ref(page, this.run(String(page.run_id)));
		if (!this.current(ref)) return null;
		const text = readJSON(this.one("SELECT json_quote(text) AS value FROM quixi_extract_pages WHERE id=?", [pageId]).value);
		if (text.length !== page.utf16 || text.length > EXTRACTION_LIMITS.pageUTF16 || !["text", "possible_scanned"].includes(String(page.classification)) || extractionTextDigest(text) !== page.text_sha) fail("MIGRATION_FAILED", "Published derived text no longer matches its digest.");
		return {
			ref,
			text,
			utf16: text.length,
			classification: page.classification
		};
	}
	readText(a) {
		this.requireCurrent(a.pageRef);
		const page = this.loadPage(a.pageRef.pageAttemptId);
		if (a.startUTF16 > page.utf16) fail("INVALID_REQUEST", "Text range starts past the page.");
		let start = a.startUTF16, end = Math.min(page.utf16, start + a.maxUTF16);
		if (start > 0 && /[\uDC00-\uDFFF]/.test(page.text[start] ?? "")) fail("INVALID_REQUEST", "Text range starts inside a surrogate pair.");
		if (end < page.utf16 && /[\uD800-\uDBFF]/.test(page.text[end - 1] ?? "")) end--;
		if (end === start && start < page.utf16) fail("INVALID_REQUEST", "Text budget cannot contain the next code point.");
		return {
			text: page.text.slice(start, end),
			startUTF16: start,
			endUTF16: end,
			totalUTF16: page.utf16,
			classification: page.classification
		};
	}
	checkedMaps(row) {
		const raw = String(row.maps);
		if (raw.length > EXTRACTION_LIMITS.stageBytes || extractionTextDigest(raw) !== row.map_digest) fail("MIGRATION_FAILED", "Derived map batch digest differs.");
		const maps = readJSON(row.maps);
		if (!Array.isArray(maps) || maps.length > EXTRACTION_LIMITS.stageSpans) fail("MIGRATION_FAILED", "Derived map batch exceeds bound.");
		return maps;
	}
	readMaps(a) {
		this.requireCurrent(a.pageRef);
		const size = Number(this.one("SELECT utf16 FROM quixi_extract_pages WHERE id=?", [a.pageRef.pageAttemptId]).utf16);
		if (a.endUTF16 > size) fail("INVALID_REQUEST", "Map range exceeds page.");
		const scope = extractionDigest({
			pageRef: a.pageRef,
			start: a.startUTF16,
			end: a.endUTF16
		});
		let sequence = 0, index = 0;
		if (a.cursor) try {
			const c = JSON.parse(a.cursor);
			if (c.scope !== scope || !Number.isInteger(c.sequence) || c.sequence < 0 || c.sequence > 1024 || !Number.isInteger(c.index) || c.index < 0 || c.index > 128) throw 0;
			sequence = c.sequence;
			index = c.index;
		} catch {
			fail("CONFLICT", "Map cursor does not describe this page/range.");
		}
		const items = [];
		let bytes = 2, scanned = 0;
		const finish = (nextCursor) => {
			const result = {
				items,
				nextCursor,
				bytes: 0
			};
			result.bytes = jsonByteLength(result);
			result.bytes = jsonByteLength(result);
			if (result.bytes > a.maxBytes) fail("OVERLOADED", "Map response envelope exceeds budget.");
			return result;
		};
		const cursor = (s, i) => json({
			scope,
			sequence: s,
			index: i
		});
		while (scanned++ < 32) {
			const row = this.one("SELECT sequence,maps,map_digest FROM quixi_extract_map_batches WHERE page_id=? AND sequence>=? AND end_utf16>? AND start_utf16<? ORDER BY sequence LIMIT 1", [
				a.pageRef.pageAttemptId,
				sequence,
				a.startUTF16,
				a.endUTF16
			]);
			if (!row) return finish(null);
			const maps = this.checkedMaps(row);
			if (row.sequence !== sequence) index = 0;
			sequence = Number(row.sequence);
			for (; index < maps.length; index++) {
				const span = maps[index];
				if (span.end <= a.startUTF16 || span.start >= a.endUTF16) continue;
				const cost = jsonByteLength(span) + Number(items.length > 0);
				if (items.length >= a.maxItems || bytes + cost > a.maxBytes - 384) {
					if (!items.length) fail("OVERLOADED", "Map response budget cannot contain one span.");
					return finish(cursor(sequence, index));
				}
				items.push(span);
				bytes += cost;
			}
			sequence++;
			index = 0;
		}
		return finish(cursor(sequence, 0));
	}
	listVisiblePages(documentId, after, limit) {
		this.check();
		if (documentId !== null && !isQuixiId(documentId) || after !== null && !isQuixiId(after) || !Number.isInteger(limit) || limit < 1 || limit > 32) fail("INVALID_REQUEST", "Invalid page enumeration budget.");
		return this.rows("SELECT p.id FROM quixi_extract_pages p JOIN quixi_extract_documents d ON d.visible_run=p.run_id WHERE p.state='published' AND p.id>? AND (? IS NULL OR d.document_id=?) ORDER BY p.id LIMIT ?", [
			after ?? "",
			documentId,
			documentId,
			limit
		]).map((row) => ({ pageAttemptId: String(row.id) }));
	}
	publications(limit) {
		this.check();
		if (!Number.isInteger(limit) || limit < 1 || limit > 32) fail("INVALID_REQUEST", "Invalid outbox budget.");
		return this.rows("SELECT * FROM quixi_extract_publications ORDER BY revision LIMIT ?", [limit]).map((row) => ({
			revision: Number(row.revision),
			documentId: String(row.document_id),
			runId: String(row.run_id),
			pageAttemptId: row.page_id === null ? null : String(row.page_id),
			kind: row.kind
		}));
	}
	acknowledge(revisions) {
		this.check();
		if (revisions.length > 32 || revisions.some((n) => !Number.isSafeInteger(n) || n < 1) || new Set(revisions).size !== revisions.length) fail("INVALID_REQUEST", "Invalid outbox acknowledgement.");
		for (const revision of revisions) {
			const row = this.one("SELECT run_id FROM quixi_extract_publications WHERE revision=?", [revision]);
			if (row) {
				this.exec("DELETE FROM quixi_extract_publications WHERE revision=?", [revision]);
				this.charge(String(row.run_id), -256);
			}
		}
	}
	/** Bounded cleanup must be called before retrying abandoned page admission.
	* Receipts/run summaries survive cleanup; original/canonical tables are untouched. */
	cleanup({ maxRows = 32, maxBytes = 1048576 } = {}) {
		this.check();
		if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 32 || !Number.isInteger(maxBytes) || maxBytes < 65536 || maxBytes > 1048576) fail("INVALID_REQUEST", "Invalid cleanup slice.");
		return this.tx(() => {
			let deleted = 0, bytes = 0;
			while (deleted < maxRows) {
				const queued = this.one("SELECT page_id FROM quixi_extract_cleanup_pages ORDER BY page_id LIMIT 1");
				if (queued) {
					const page = this.one("SELECT id,run_id,state,published_bytes FROM quixi_extract_pages WHERE id=?", [queued.page_id]);
					if (!page) {
						this.exec("DELETE FROM quixi_extract_cleanup_pages WHERE page_id=?", [queued.page_id]);
						deleted++;
						continue;
					}
					const run = this.run(String(page.run_id)), doc = this.document(String(run.document_id));
					const obsolete = page.state === "abandoned" || run.state === "cleared" || run.id !== doc.latest_run && run.id !== doc.visible_run;
					let handled = false;
					for (const table of ["text", "map"]) {
						if (table === "map" && !obsolete) continue;
						const row = this.one(`SELECT sequence,bytes FROM quixi_extract_${table}_batches WHERE page_id=? ORDER BY sequence LIMIT 1`, [page.id]);
						if (!row) continue;
						if (bytes + Number(row.bytes) > maxBytes) return {
							rows: deleted,
							bytes
						};
						this.exec(`DELETE FROM quixi_extract_${table}_batches WHERE page_id=? AND sequence=?`, [page.id, row.sequence]);
						this.charge(String(run.id), -Number(row.bytes));
						bytes += Number(row.bytes);
						deleted++;
						handled = true;
						break;
					}
					if (handled) continue;
					if (obsolete) {
						const cost = Number(page.published_bytes) + 512;
						if (bytes + cost > maxBytes) break;
						this.exec("DELETE FROM quixi_extract_pages WHERE id=?", [page.id]);
						this.charge(String(run.id), -cost);
						bytes += cost;
					}
					this.exec("DELETE FROM quixi_extract_cleanup_pages WHERE page_id=?", [page.id]);
					deleted++;
					continue;
				}
				const run = this.one("SELECT run_id,after_id FROM quixi_extract_cleanup_runs ORDER BY run_id LIMIT 1");
				if (!run) break;
				const limit = Math.min(32, maxRows - deleted), pages = this.rows("SELECT id FROM quixi_extract_pages WHERE run_id=? AND id>? ORDER BY id LIMIT ?", [
					run.run_id,
					run.after_id,
					limit
				]);
				for (const page of pages) this.queuePage(String(page.id));
				if (pages.length < limit) this.exec("DELETE FROM quixi_extract_cleanup_runs WHERE run_id=?", [run.run_id]);
				else this.exec("UPDATE quixi_extract_cleanup_runs SET after_id=? WHERE run_id=?", [pages.at(-1).id, run.run_id]);
				deleted += Math.max(1, pages.length);
			}
			return {
				rows: deleted,
				bytes
			};
		});
	}
};
//#endregion
export { ExtractionRepository, extractionDigest, extractionMapDigest, extractionTextDigest };
