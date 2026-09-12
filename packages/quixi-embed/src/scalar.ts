/** Owned C scalar execution. Numeric kernels and tokenization run inside WASM. */
/** Exact for accepted inputs; tokenCount saturates at 513 when overflow is true. */
export interface TokenInspection {tokenCount:number;overflow:boolean;inputSha256:string}
export type EmbeddingRole = 'query' | 'document';
export type CpuBackend = 'wasm-scalar-fp32' | 'wasm-simd-fp32';
export interface CpuEncoder<Backend extends CpuBackend = CpuBackend> {
  readonly backend: Backend;
  tokenize(text: string, role: EmbeddingRole): Uint32Array;
  inspect(text: string, role: EmbeddingRole): TokenInspection;
  embedQuery(text: string): Float32Array;
  embedDocument(text: string): Float32Array;
  embedDocuments(texts: readonly string[]): Float32Array[];
  memory(): { modelBytes: number; workspaceBytes: number; linearMemoryBytes: number };
  dispose(): void;
}
export type ScalarEncoder = CpuEncoder<'wasm-scalar-fp32'>;
export type SimdEncoder = CpuEncoder<'wasm-simd-fp32'>;
interface ScalarExports {
  qx_backend(): number;
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(bytes: number): number;
  free(pointer: number): void;
  qx_model_load(pointer: number, bytes: number, status: number): number;
  qx_model_free(model: number): void;
  qx_model_bytes(model: number): number;
  qx_workspace_create(tokens: number): number;
  qx_workspace_free(workspace: number): void;
  qx_workspace_bytes(workspace: number): number;
  qx_sha256?(bytes:number,length:number,output:number):void;
  qx_inspect_tokens?(model: number, text: number, bytes: number, role: number, count: number): number;
  qx_tokenize(model: number, text: number, bytes: number, role: number, ids: number, count: number): number;
  qx_embed_document(model: number, workspace: number, text: number, bytes: number, output: number): number;
  qx_embed_query(model: number, workspace: number, text: number, bytes: number, output: number): number;
}
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_MODEL_BYTES = 128 * 1024 * 1024;
const errors = ['ok', 'invalid argument', 'configured limit exceeded', 'invalid model package',
  'unsupported model version', 'model integrity or identity mismatch', 'allocation failed',
  'invalid UTF-8', 'nonfinite output', 'workspace already in use'];

/** Use in a dedicated worker: scalar inference is synchronous and CPU intensive.
 * The caller owns asset retrieval and must supply the verified local artifact.
 * The C loader independently verifies every frozen tensor and tokenizer section.
 */
export async function createCpuEncoder<Backend extends CpuBackend>(backend: Backend, options: {
  wasm: BufferSource | WebAssembly.Module;
  model: Uint8Array;
}): Promise<CpuEncoder<Backend>> {
  if (options.model.byteLength > MAX_MODEL_BYTES) throw new RangeError('Model exceeds 128 MiB');
  const imports = { env: { emscripten_notify_memory_growth() { /* Views are recreated after each C call. */ } } };
  const instantiated = options.wasm instanceof WebAssembly.Module
    ? await WebAssembly.instantiate(options.wasm, imports)
    : (await WebAssembly.instantiate(options.wasm, imports)).instance;
  let engine: ScalarExports | null = instantiated.exports as unknown as ScalarExports;
  engine._initialize();
  if (typeof engine.qx_backend !== 'function' || engine.qx_backend() !== (backend === 'wasm-simd-fp32' ? 1 : 0))
    throw new Error(`WASM artifact does not implement requested backend ${backend}`);
  let model = 0, workspace = 0;
  const allocations: number[] = [];
  const encoder = new TextEncoder();
  function live(): ScalarExports {
    if (!engine) throw new Error('CPU encoder has been disposed');
    return engine;
  }
  function allocate(bytes: number): number {
    const pointer = live().malloc(bytes);
    if (!pointer) throw new Error('WASM allocation failed');
    allocations.push(pointer);
    return pointer;
  }
  function check(status: number): void {
    if (status) throw new Error(`QuixiEmbed: ${errors[status] ?? `status ${status}`}`);
  }
  function dispose(): void {
    if (!engine) return;
    if (workspace) engine.qx_workspace_free(workspace);
    if (model) engine.qx_model_free(model);
    for (const pointer of allocations) engine.free(pointer);
    allocations.length = 0;
    workspace = model = 0;
    engine = null;
  }
  try {
    const status = allocate(4);
    const inputModel = allocate(options.model.byteLength);
    new Uint8Array(live().memory.buffer, inputModel, options.model.byteLength).set(options.model);
    model = live().qx_model_load(inputModel, options.model.byteLength, status);
    const code = new DataView(live().memory.buffer).getUint32(status, true);
    live().free(inputModel);
    allocations.splice(allocations.indexOf(inputModel), 1);
    check(code);
    if (!model) throw new Error('Model loading returned no model');
    workspace = live().qx_workspace_create(512);
    if (!workspace) throw new Error('Workspace allocation failed');
    const input = allocate(MAX_TEXT_BYTES);
    const ids = allocate(512 * 4);
    const output = allocate(384 * 4), digest = allocate(32);
    function write(text: string): number {
      live();
      if (typeof text !== 'string') throw new TypeError('Embedding input must be a string');
      if (text.length > MAX_TEXT_BYTES) throw new RangeError('Text exceeds 1 MiB');
      const encoded = encoder.encode(text);
      if (encoded.byteLength > MAX_TEXT_BYTES) throw new RangeError('UTF-8 text exceeds 1 MiB');
      new Uint8Array(live().memory.buffer, input, encoded.byteLength).set(encoded);
      return encoded.byteLength;
    }
    function embed(text: string, role: EmbeddingRole): Float32Array {
      const bytes = write(text);
      const native = live();
      check(role === 'query'
        ? native.qx_embed_query(model, workspace, input, bytes, output)
        : native.qx_embed_document(model, workspace, input, bytes, output));
      return new Float32Array(live().memory.buffer, output, 384).slice();
    }
    return {
      backend,
      tokenize(text, role) {
        if (role !== 'query' && role !== 'document') throw new TypeError('Invalid embedding role');
        const bytes = write(text);
        check(live().qx_tokenize(model, input, bytes, role === 'query' ? 1 : 0, ids, status));
        const count = new DataView(live().memory.buffer).getUint32(status, true);
        return new Uint32Array(live().memory.buffer, ids, count).slice();
      },
      inspect(text, role) {
        if(role !== 'query' && role !== 'document')throw new TypeError('Invalid embedding role');
        const bytes=write(text),inspect=live().qx_inspect_tokens;
        if(!inspect||!live().qx_sha256)throw new Error('Strict token preflight requires CPU artifact 1.0.1 or newer');
        check(inspect(model,input,bytes,role === 'query'?1:0,status));
        const tokenCount=new DataView(live().memory.buffer).getUint32(status,true);
        live().qx_sha256!(input,bytes,digest);
        const inputSha256=Array.from(new Uint8Array(live().memory.buffer,digest,32),value=>value.toString(16).padStart(2,'0')).join('');
        return {tokenCount,overflow:tokenCount>512,inputSha256};
      },
      embedQuery(text) { return embed(text, 'query'); },
      embedDocument(text) { return embed(text, 'document'); },
      embedDocuments(texts) {
        live();
        if (texts.length > 32) throw new RangeError('A CPU batch may contain at most 32 texts');
        return texts.map((text) => embed(text, 'document'));
      },
      memory() {
        const native = live();
        return { modelBytes: native.qx_model_bytes(model), workspaceBytes: native.qx_workspace_bytes(workspace),
          linearMemoryBytes: native.memory.buffer.byteLength };
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Force the independently built scalar oracle; never silently substitute SIMD. */
export function createScalarEncoder(options: { wasm: BufferSource | WebAssembly.Module; model: Uint8Array }): Promise<ScalarEncoder> {
  return createCpuEncoder('wasm-scalar-fp32', options);
}
