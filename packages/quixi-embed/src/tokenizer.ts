import type { EmbeddingRole, TokenInspection } from './scalar.ts';

export const TOKEN_ORIGIN={source:0,queryPrefix:1,framing:2} as const;
export const ARCTIC_QUERY_PREFIX='Represent this sentence for searching relevant passages: ';
export interface TokenOffsets {
  ids:Uint32Array;byteOffsets:Uint32Array;utf16Offsets:Uint32Array;origins:Uint8Array;
  tokenCount:number;inputBytes:number;inputUtf16Units:number;
}
export class TokenOffsetCapacityError extends RangeError {
  readonly code='offset-capacity';readonly capacity:number;readonly requiredTokens:number;
  constructor(capacity:number,requiredTokens:number){
    super(`Token offsets require ${requiredTokens} records; capacity is ${capacity}`);
    this.name='TokenOffsetCapacityError';this.capacity=capacity;this.requiredTokens=requiredTokens;
  }
}
export interface ArcticTokenizer {
  inspect(text: string, role?: EmbeddingRole): TokenInspection;
  tokenize(text: string, role?: EmbeddingRole): Uint32Array;
  /** Full original-source provenance; ranges may overlap and leave removed-text gaps. */
  tokenizeWithOffsets(text:string,options?:{role?:EmbeddingRole;maxTokens?:number}):TokenOffsets;
  memory(): { tokenizerBytes: number; linearMemoryBytes: number; offsetScratchBytes:number; peakOffsetScratchBytes:number };
  dispose(): void;
}
interface TokenizerExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(bytes: number): number;
  free(pointer: number): void;
  qx_tokenizer_load(bytes: number, length: number, status: number): number;
  qx_tokenizer_free(tokenizer: number): void;
  qx_tokenizer_bytes(tokenizer: number): number;
  qx_sha256?(bytes:number,length:number,output:number):void;
  qx_tokenizer_inspect?(tokenizer: number, text: number, bytes: number, role: number, count: number): number;
  qx_tokenizer_encode(tokenizer: number, text: number, bytes: number, role: number, ids: number, count: number): number;
  qx_tokenizer_encode_offsets?(tokenizer:number,text:number,bytes:number,role:number,records:number,capacity:number,count:number):number;
}

/** Load the ~0.5 MB tokenizer artifact independently of model weights/inference. */
export async function createArcticTokenizer(options: {
  wasm: BufferSource | WebAssembly.Module;
  tokenizer: Uint8Array;
}): Promise<ArcticTokenizer> {
  if (options.tokenizer.byteLength > 2 * 1024 * 1024) throw new RangeError('Tokenizer exceeds 2 MiB');
  const imports = { env: { emscripten_notify_memory_growth() {} } };
  const instance = options.wasm instanceof WebAssembly.Module
    ? await WebAssembly.instantiate(options.wasm, imports)
    : (await WebAssembly.instantiate(options.wasm, imports)).instance;
  let engine: TokenizerExports | null = instance.exports as unknown as TokenizerExports;
  engine._initialize();
  const allocations: number[] = [];
  let tokenizer = 0,offsetScratchBytes=0,peakOffsetScratchBytes=0;
  function live(): TokenizerExports {
    if (!engine) throw new Error('Tokenizer has been disposed');
    return engine;
  }
  function allocate(bytes: number): number {
    const pointer = live().malloc(bytes);
    if (!pointer) throw new Error('WASM allocation failed');
    allocations.push(pointer);
    return pointer;
  }
  function dispose(): void {
    if (!engine) return;
    if (tokenizer) engine.qx_tokenizer_free(tokenizer);
    for (const pointer of allocations) engine.free(pointer);
    allocations.length = 0;
    tokenizer = 0;
    engine = null;
  }
  try {
    const status = allocate(4);
    const source = allocate(options.tokenizer.byteLength);
    new Uint8Array(live().memory.buffer, source, options.tokenizer.byteLength).set(options.tokenizer);
    tokenizer = live().qx_tokenizer_load(source, options.tokenizer.byteLength, status);
    const code = new DataView(live().memory.buffer).getUint32(status, true);
    live().free(source);
    allocations.splice(allocations.indexOf(source), 1);
    if (code || !tokenizer) throw new Error(`Tokenizer package rejected: status ${code}`);
    const input = allocate(1024 * 1024), ids = allocate(512 * 4), digest = allocate(32);
    const encoder = new TextEncoder();
    function write(text:string,role:EmbeddingRole):number{
      live();
      if(role!=='query'&&role!=='document')throw new TypeError('Invalid embedding role');
      if(typeof text!=='string')throw new TypeError('Tokenizer input must be a string');
      if(text.length>1024*1024)throw new RangeError('Text exceeds 1 MiB');
      const bytes=encoder.encode(text);
      if(bytes.length>1024*1024)throw new RangeError('UTF-8 text exceeds 1 MiB');
      new Uint8Array(live().memory.buffer,input,bytes.length).set(bytes);return bytes.length;
    }
    return {
      tokenizeWithOffsets(text,options={}){
        const maxTokens=options.maxTokens??8192;
        if(!Number.isInteger(maxTokens)||maxTokens<2||maxTokens>65536)throw new RangeError('Offset capacity must be an integer in 2..65536');
        const role=options.role??'document',bytes=write(text,role),encode=live().qx_tokenizer_encode_offsets;
        if(!encode)throw new Error('Original-source token offsets require CPU artifact 1.0.2 or newer');
        const pointer=allocate(maxTokens*24);offsetScratchBytes=maxTokens*24;
        peakOffsetScratchBytes=Math.max(peakOffsetScratchBytes,offsetScratchBytes);
        try{
          const code=encode(tokenizer,input,bytes,role==='query'?1:0,pointer,maxTokens,status);
          const tokenCount=new DataView(live().memory.buffer).getUint32(status,true);
          if(code===2&&tokenCount>maxTokens)throw new TokenOffsetCapacityError(maxTokens,tokenCount);
          if(code)throw new Error(`Token offsets failed: status ${code}`);
          if(tokenCount<2||tokenCount>maxTokens)throw new Error('Invalid token offset count');
          const records=new Uint32Array(live().memory.buffer,pointer,tokenCount*6);
          const ids=new Uint32Array(tokenCount),byteOffsets=new Uint32Array(tokenCount*2),utf16Offsets=new Uint32Array(tokenCount*2),origins=new Uint8Array(tokenCount);
          for(let i=0;i<tokenCount;i++){
            ids[i]=records[i*6]!;byteOffsets[i*2]=records[i*6+1]!;byteOffsets[i*2+1]=records[i*6+2]!;
            utf16Offsets[i*2]=records[i*6+3]!;utf16Offsets[i*2+1]=records[i*6+4]!;origins[i]=records[i*6+5]!;
          }
          return{ids,byteOffsets,utf16Offsets,origins,tokenCount,inputBytes:bytes,inputUtf16Units:text.length};
        }finally{live().free(pointer);allocations.splice(allocations.indexOf(pointer),1);offsetScratchBytes=0;}
      },
      inspect(text,role='document'){
        const bytes=write(text,role),inspect=live().qx_tokenizer_inspect;
        if(!inspect||!live().qx_sha256)throw new Error('Strict token preflight requires CPU artifact 1.0.1 or newer');
        const code=inspect(tokenizer,input,bytes,role==='query'?1:0,status);
        if(code)throw new Error(`Tokenizer failed: status ${code}`);
        const tokenCount=new DataView(live().memory.buffer).getUint32(status,true);
        live().qx_sha256!(input,bytes,digest);
        const inputSha256=Array.from(new Uint8Array(live().memory.buffer,digest,32),value=>value.toString(16).padStart(2,'0')).join('');
        return{tokenCount,overflow:tokenCount>512,inputSha256};
      },
      tokenize(text, role = 'document') {
        const bytes=write(text,role);
        const code = live().qx_tokenizer_encode(tokenizer, input, bytes, role === 'query' ? 1 : 0, ids, status);
        if (code) throw new Error(`Tokenizer failed: status ${code}`);
        const count = new DataView(live().memory.buffer).getUint32(status, true);
        return new Uint32Array(live().memory.buffer, ids, count).slice();
      },
      memory() { return { tokenizerBytes: live().qx_tokenizer_bytes(tokenizer), linearMemoryBytes: live().memory.buffer.byteLength,offsetScratchBytes,peakOffsetScratchBytes }; },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
