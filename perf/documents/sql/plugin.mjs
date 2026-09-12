import {readFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'../../..');
const pins=JSON.parse(readFileSync(new URL('./pins.json',import.meta.url),'utf8'));
const runtime=readFileSync(new URL('./runtime.mjs',import.meta.url),'utf8');
const digest=source=>createHash('sha256').update(source).digest('hex');
const virtual='\0quixi-sql-observer';
export const sqlTransformEvidence=[];
export const sqlTransformedSources=new Map();
export function transformSqlObserver(code,path){
 if(!(path in pins))return null;
 if(digest(code)!==pins[path])throw new Error(`SQL diagnostic source hash mismatch: ${path}`);
 let anchor,replacement;
 if(path.endsWith('sqlite-module.ts')){
  anchor='    }) as Promise<StorageSqliteModule>;';
  replacement='    }).then(__quixiInstallSqlObserver) as Promise<StorageSqliteModule>;';
 }else{
  anchor='      } else result = await fenced(work.selection, () => database!.execute(work.call, workerId, work.controller.signal));';
  replacement='      } else result = await __quixiObserveSqlOperation(work.call, () => fenced(work.selection, () => database!.execute(work.call, workerId, work.controller.signal)));';
 }
 if(code.split(anchor).length!==2)throw new Error(`SQL diagnostic anchor count mismatch: ${path}`);
 const imports=path.endsWith('sqlite-module.ts')?'installSqlObserver as __quixiInstallSqlObserver':'observeSqlOperation as __quixiObserveSqlOperation';
 const transformed=`import { ${imports} } from 'quixi-sql-observer';\n`+code.replace(anchor,replacement);
 return {code:transformed,evidence:{path,sourceSha256:digest(code),transformedSha256:digest(transformed),runtimeSha256:digest(runtime),changes:1}};
}
export function sqlObserverPlugin(){return {
 name:'quixi-perf-sql-observer',enforce:'pre',
 resolveId(id){if(id==='quixi-sql-observer')return virtual;},
 load(id){if(id===virtual)return runtime;},
 transform(code,id){const path=relative(root,id.split('?')[0]).replaceAll('\\','/');const result=transformSqlObserver(code,path);if(!result)return null;if(sqlTransformEvidence.length>=32)throw new Error("SQL diagnostic transform evidence limit");sqlTransformEvidence.push(result.evidence);sqlTransformedSources.set(path,result.code);return {code:result.code,map:null};}
};}
