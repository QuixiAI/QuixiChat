// Test-build observer: fixed labels/numeric aggregates only. Never stores SQL,
// bindings, operation arguments, IDs, database names, results or error messages.
const operations = new Set(['beginBlobTransfer','finishBlobTransfer','discardBlobTransfer','readBlobTransfer','sliceBlobTransfer','archiveWorkspace','commit','diagnostics','readEntity','readEntities','beginDocumentExtraction','resumeDocumentExtraction','beginExtractionPage','stagePageText','publishExtractionPage','advanceExtractionPageIndex','completeDocumentExtraction','interruptDocumentExtraction','getDocumentExtraction','searchArchive','searchStatus','upload','read','ack']);
const methods=['exec','selectValue','selectValues','selectArray','selectArrays','selectObject','selectObjects'];
const bucketLimitsMs=[0.01,0.05,0.1,0.25,0.5,1,2,4,8,16,32,64,128,256,1024];
const prototypes = new WeakSet();
const active = new Set();
let rows=new Map(), scopes=new Map(), nestedCalls=0, overflowCalls=0, overlapScopes=0, depth=0;
const fresh=()=>({count:0,totalMs:0,minMs:null,maxMs:0,errors:0,histogram:new Array(bucketLimitsMs.length+1).fill(0)});
function account(stats,ms,failed){stats.count++;stats.totalMs+=ms;stats.minMs=stats.minMs===null?ms:Math.min(stats.minMs,ms);stats.maxMs=Math.max(stats.maxMs,ms);if(failed)stats.errors++;let bin=bucketLimitsMs.findIndex(limit=>ms<=limit);stats.histogram[bin<0?bucketLimitsMs.length:bin]++;}
function category(sql){
 if(typeof sql!=='string')return 'other';
 const prefix=sql.slice(0,2048).trimStart();
 if(/^BEGIN\b/i.test(prefix))return 'transaction.begin';
 if(/^COMMIT\b|^END\b/i.test(prefix))return 'transaction.commit';
 if(/^ROLLBACK\b/i.test(prefix))return 'transaction.rollback';
 if(/^SAVEPOINT\b|^RELEASE\b/i.test(prefix))return 'transaction.savepoint';
 if(/^PRAGMA\b|^(?:CREATE|ALTER|DROP)\b/i.test(prefix))return 'schema.configure';
 if(/\bsqlite_schema\b/i.test(prefix))return 'schema.read';
 const write=/^(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(prefix);
 if(/\bquixi_local_operation_claims\b/i.test(prefix))return write?'claim.write':'claim.read';
 if(/\bquixi_extract_text_batches\b/i.test(prefix))return write?'extraction.text.write':'extraction.text.read';
 if(/\bquixi_extract_map_batches\b/i.test(prefix))return write?'extraction.map.write':'extraction.map.read';
 if(/\bquixi_extract_operations\b/i.test(prefix))return write?'extraction.receipt.write':'extraction.receipt.read';
 if(/\bquixi_extract_meta\b|\bused_bytes\b/i.test(prefix))return write?'extraction.accounting.write':'extraction.accounting.read';
 if(/\bquixi_extract_/i.test(prefix))return write?'extraction.other.write':'extraction.other.read';
 if(/\bquixi_search_/i.test(prefix))return write?'search.write':'search.read';
 if(/\bquixi_archive_operations\b/i.test(prefix))return write?'archive.receipt.write':'archive.receipt.read';
 if(/\bquixi_records\b|\bquixi_edges\b|\bquixi_sync_ops\b/i.test(prefix))return write?'canonical.write':'canonical.read';
 return write?'other.write':'other.read';
}
function role(db){const name=db.filename;return name==='/archive.sqlite3'?'archive':typeof name==='string'&&/selection/.test(name)?'selection':'other';}
function current(){return active.size===0?'unattributed':active.size===1?[...active][0].label:'overlap';}
export function installSqlObserver(sqlite){
 const prototype=sqlite?.oo1?.DB?.prototype;
 if(!prototype || methods.some(method=>typeof prototype[method]!=='function'))throw new Error('SQL diagnostic incompatible SQLite OO1 API');
 if(prototypes.has(prototype))return sqlite;
 prototypes.add(prototype);
 for(const method of methods){const original=prototype[method];prototype[method]=function(...args){
  if(depth){nestedCalls++;return Reflect.apply(original,this,args);}
  // Classification occurs before the timed call and does not inspect bindings.
  const sql=typeof args[0]==='string'?args[0]:args[0]?.sql;
  let key=`${current()}|${role(this)}|${method}|${category(sql)}`;
  if(!rows.has(key) && rows.size>=512){overflowCalls++;key='overflow|other|other|other';}
  let stats=rows.get(key);if(!stats){stats=fresh();rows.set(key,stats);}
  const start=performance.now();let failed=true;depth++;
  try{const result=Reflect.apply(original,this,args);failed=false;return result;}
  finally{depth--;account(stats,performance.now()-start,failed);}
 };}
 return sqlite;
}
export async function observeSqlOperation(call,work){
 const proposed=call?.kind==='request'?call.request?.operation:call?.kind;
 const label=operations.has(proposed)?proposed:'other';
 const token={label};if(active.size)overlapScopes++;
 const tracked=active.size<8;if(tracked)active.add(token);const start=performance.now();let failed=true;
 try{const result=await work();failed=false;return result;}
 finally{if(tracked)active.delete(token);let stats=scopes.get(label);if(!stats){stats=fresh();scopes.set(label,stats);}account(stats,performance.now()-start,failed);}
}
function snapshot(reset=false){
 if(active.size && reset)throw new Error('Cannot reset SQL diagnostic during an operation');
 const result={version:1,bucketLimitsMs:[...bucketLimitsMs],activeScopes:active.size,nestedCalls,overflowCalls,overlapScopes,rows:[...rows].map(([key,value])=>{const [operation,database,method,category]=key.split('|');return {operation,database,method,category,...value,histogram:[...value.histogram]};}),operations:[...scopes].map(([operation,value])=>({operation,...value,histogram:[...value.histogram]}))};
 if(reset){rows=new Map();scopes=new Map();nestedCalls=0;overflowCalls=0;overlapScopes=0;}
 return result;
}
Object.defineProperty(globalThis,'__quixiSqlDiagnostic',{value:Object.freeze({snapshot}),configurable:false,writable:false});
