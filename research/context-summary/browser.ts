import { cases } from './cases.ts';
import { verifyCorpusGuards } from './quality.ts';
const result:{status:string;checks:Array<{name:string;elapsedMs:number}>;quality:unknown;error?:string}={status:'running',checks:[],quality:null};
Object.assign(window,{summaryDesignResult:result});
try{
 for(const entry of cases){const start=performance.now();await entry.run();result.checks.push({name:entry.name,elapsedMs:performance.now()-start});}
 result.quality=verifyCorpusGuards();result.checks.push({name:'quality corpus evidence and negative-control annotations are well formed',elapsedMs:0});result.status='passed';
}catch(error){result.status='failed';result.error=String(error instanceof Error?error.stack:error);}
