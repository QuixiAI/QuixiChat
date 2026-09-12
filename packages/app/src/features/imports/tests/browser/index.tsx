import type {StorageOperations} from '@quixi/core/contracts';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {ImportPanel} from '../../index.ts';
import { createIsolatedStorageClient as createStorageClient } from "../../../../../../storage/tests/isolated-client.ts";
import {createWebHost} from '../../../../../../../apps/web/src/host/index.ts';
const archiveId=new URL(location.href).searchParams.get('archive')??'test-import-panel-acceptance';
const storage=createStorageClient({archiveId,timeoutMs:60_000}),host=createWebHost({destinations:[]});
const workspaceId='00000000-0000-4000-8000-000000000021';
let armStage=false,stageHeld=false,releaseStage:(()=>void)|null=null,failNextOperation:string|null=null;
const request=storage.request.bind(storage);
storage.request=async<K extends keyof StorageOperations>(requestId:string,operation:K,args:StorageOperations[K]['args']):Promise<StorageOperations[K]['result']>=>{if(failNextOperation===operation){failNextOperation=null;throw Object.assign(new Error('Synthetic storage failure during the import step'),{code:'IO_ERROR'});}const result=await request(requestId,operation,args);if(operation==='stageImportRecords'&&armStage){armStage=false;stageHeld=true;await new Promise<void>(resolve=>{releaseStage=resolve;});stageHeld=false;}return result;};
let selectedHandles=0,releasedHandles=0,openedThread:string|null=null;
const choose=host.chooseFiles.bind(host),release=host.releaseFile.bind(host);
host.chooseFiles=async(...args)=>{const result=await choose(...args);selectedHandles+=result.length;return result;};
host.releaseFile=async(...args)=>{await release(...args);releasedHandles++;};
// Browser headless saves exercise the production download fallback, with no privileged host behavior substituted.
Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true});
// WebKit shares one OPFS per origin across Playwright profiles, and the host keeps
// at most four retained downloads per origin; a run that saved a report leaves one
// behind, so the fixture starts from a clean download directory in every engine.
for(const retained of await host.listTemporaryDownloads())await host.clearTemporaryDownload(crypto.randomUUID(),retained.id);
const root=createRoot(document.getElementById('root')!);
root.render(<StrictMode><ImportPanel storage={storage} host={host} archiveId={archiveId} workspaceId={workspaceId} onOpenThread={threadId=>{openedThread=threadId;}}/></StrictMode>);
(globalThis as typeof globalThis&{panelTest:unknown}).panelTest={
 armPause(){armStage=true;},stageHeld(){return stageHeld;},releaseStage(){releaseStage?.();releaseStage=null;},
 /** The next storage request with this operation fails once, as a storage fault would. */
 failNext(operation:string){failNextOperation=operation;},
 async runs(){return storage.request(crypto.randomUUID(),'importRunList',{state:null,page:{maxItems:16,maxBytes:100_000,cursor:null}});},
 async diagnostics(){return storage.request(crypto.randomUUID(),'diagnostics',null);},
 handles(){return{selectedHandles,releasedHandles,openedThread};},
 async threads(){return storage.request(crypto.randomUUID(),'readEntities',{collection:'threads',threadId:null,page:{maxItems:10,maxBytes:100_000,cursor:null}});},
 async records(collection:'messages'|'parts'|'rawObjects'|'provenance'|'threads'|'importSources'|'events'){return storage.request(crypto.randomUUID(),'readEntities',{collection,threadId:null,page:{maxItems:64,maxBytes:900_000,cursor:null}});},
 async groups(runId:string){return storage.request(crypto.randomUUID(),'importRunReadGroups',{runId,page:{maxItems:16,maxBytes:900_000,cursor:null}});},
 async search(query:string){return storage.request(crypto.randomUUID(),'searchArchive',{query,mode:'exact',filters:{},page:{maxItems:16,maxBytes:200_000,cursor:null}});},
 async unmount(){root.unmount();await new Promise(resolve=>setTimeout(resolve,100));return{selectedHandles,releasedHandles};},
 async close(){root.unmount();await new Promise(resolve=>setTimeout(resolve,100));await storage.close();await host.dispose();},
};
