import type {HostClient,HostFile,StorageClient,ImportRun,ImportWorkGroup,EntityPage,CapabilityState,ExtensionOffer,ExtensionTransferProgress} from '@quixi/core/contracts';
import type {JsonObject,QuixiId} from '@quixi/core/model';
import {beginChatgptImport,beginClaudeImport,importChatgptSource,importClaudeSource,importProviderZip,prepareImportReport,setImportRunState} from '@quixi/importers';
import type {ImportRuntime,ImporterProgress} from '@quixi/importers';
import {discardUnfinishedImport} from './discard.ts';
import {hostByteSource} from './host-files.ts';

export interface ImportPanelProps {
 storage:StorageClient;host:HostClient;archiveId:string;workspaceId:QuixiId;
 onOpenThread?:(threadId:QuixiId)=>void;onImportComplete?:(runId:QuixiId)=>void;
}
export interface ImportSnapshot {
 busy:boolean;discarding:boolean;choosing:boolean;error:string|null;notice:string|null;selectedFile:HostFile|null;
 progress:ImporterProgress|null;runs:readonly ImportRun[];runsCursor:string|null;selectedRun:ImportRun|null;
 groups:readonly ImportWorkGroup[];groupsCursor:string|null;warnings:readonly JsonObject[];warningsCursor:string|null;warningGroup:ImportWorkGroup|null;
 availableBytes:number|null;report:{transferId:string;byteLength:number;runId:string}|null;reportBusy:boolean;
 /** Browser-extension transfers (product §24): host capability, this page's pairing code, the pending offer and its live progress. */
 extension:{capability:CapabilityState|null;pairingCode:string|null;offer:ExtensionOffer|null;progress:ExtensionTransferProgress|null};
}
const budget={maxItems:16,maxBytes:900_000,cursor:null};
function message(error:unknown):string{
 const code=error&&typeof error==='object'&&'code'in error?String(error.code):null;
 if(code==='UNKNOWN_OUTCOME')return 'The last step may have been saved. Resume this import to check its saved progress.';
 if(code==='OVERLOADED')return 'The device is busy. Saved import progress is retained; try again shortly.';
 if(code==='QUOTA_EXCEEDED'||code==='STORAGE_FULL')return 'Storage is full. Free some space, then resume the import.';
 if(error instanceof Error&&/Select the original source/.test(error.message))return 'The original export file is needed to continue this import because its bytes were not fully saved. Choose the same file again, then resume.';
 return error instanceof Error?error.message:String(error);
}
export function createImportController(props:ImportPanelProps){
 let state:ImportSnapshot=Object.freeze({busy:false,discarding:false,choosing:false,error:null,notice:null,selectedFile:null,progress:null,runs:[],runsCursor:null,selectedRun:null,groups:[],groupsCursor:null,warnings:[],warningsCursor:null,warningGroup:null,availableBytes:null,report:null,reportBusy:false,extension:{capability:null,pairingCode:null,offer:null,progress:null}});
 let extensionUnsubscribe:(()=>void)[]=[];let extensionOffer:{offer:ExtensionOffer;accountScope:string}|null=null;
 const listeners=new Set<()=>void>();let disposed=false,cancelled=false,active:Promise<void>|null=null,loadingRuns:Promise<void>|null=null;
 let selected:HostFile|null=null;let pendingState:Parameters<typeof setImportRunState>[1]|null=null;
 let startIntent:{provider:'openai'|'anthropic';args:{operationId:string;runId:string;workspaceId:string;accountScope:string;recordedAt:number}}|null=null;
 let unsubscribe:(()=>void)|null=null;let queryEpoch=0;const id=()=>crypto.randomUUID();
 const patch=(value:Partial<ImportSnapshot>)=>{if(disposed)return;state=Object.freeze({...state,...value});for(const listener of listeners)listener();};
 const runtime=():ImportRuntime=>({storage:props.storage,nextId:id,now:()=>Date.now(),cancelled:()=>cancelled,onProgress:progress=>patch({progress})});
 async function sendState(args:Omit<Parameters<typeof setImportRunState>[1],'operationId'>):Promise<ImportRun>{
  if(pendingState){await setImportRunState(runtime(),pendingState);pendingState=null;}
  pendingState={...args,operationId:id()};try{const result=await setImportRunState(runtime(),pendingState);pendingState=null;return result;}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='UNKNOWN_OUTCOME'))pendingState=null;throw error;}
 }
 async function releaseSelected():Promise<void>{if(selected){const old=selected;selected=null;await props.host.releaseFile(id(),old.id);}patch({selectedFile:null});}
 async function releaseReport():Promise<void>{if(state.report){const report=state.report;patch({report:null});await props.host.releaseTransfer(id(),report.transferId);}}
 async function loadRuns(cursor:string|null=null):Promise<void>{
  if(loadingRuns||disposed)return loadingRuns??Promise.resolve();
  loadingRuns=(async()=>{try{const result=await props.storage.request(id(),'importRunList',{state:null,page:{...budget,cursor}});patch({runs:(result.items as unknown as ImportRun[]).filter(run=>run.workspaceId===props.workspaceId),runsCursor:result.nextCursor});}catch(error){patch({error:message(error)});}finally{loadingRuns=null;}})();return loadingRuns;
 }
 async function selectRun(runId:string):Promise<void>{
  if(state.busy||state.reportBusy)return;const epoch=++queryEpoch;try{await releaseReport();const run=await props.storage.request(id(),'importRunStatus',{runId});if(run.workspaceId!==props.workspaceId)throw new Error('This import belongs to a different workspace');const groups=await props.storage.request(id(),'importRunReadGroups',{runId,page:budget});if(epoch!==queryEpoch)return;patch({selectedRun:run,groups:groups.items as unknown as ImportWorkGroup[],groupsCursor:groups.nextCursor,warnings:[],warningsCursor:null,warningGroup:null,error:null});}catch(error){patch({error:message(error)});}
 }
 async function refresh():Promise<void>{await loadRuns();if(state.selectedRun)await selectRun(state.selectedRun.runId);}
 async function execute(run:ImportRun,format:'json'|'zip',sourceName:string):Promise<void>{
  cancelled=false;patch({busy:true,error:null,notice:null,progress:null,selectedRun:run});
  try{
   if(run.state==='cancelled'||run.state==='complete')throw new Error('This import is already finished');
   run=await sendState({runId:run.runId,state:'running',summary:{...run.summary,format,sourceKey:'file-0',sourceName}});patch({selectedRun:run});
   const source=selected?hostByteSource(props.host,selected,id,()=>cancelled):undefined;
   if(format==='zip')await importProviderZip(runtime(),{runId:run.runId,sourceKey:'file-0',maxEntryBytes:state.availableBytes===null?4_294_967_296:Math.max(1,state.availableBytes),...(source?{source}:{})});
   else await(run.provider==='openai'?importChatgptSource:importClaudeSource)(runtime(),{runId:run.runId,sourceKey:'file-0',...(source?{source}:{})});
   run=await sendState({runId:run.runId,state:'complete',summary:{...run.summary,completedAt:Date.now()}});patch({selectedRun:run,notice:'Import complete. Original files and conversation history are saved.'});await releaseSelected();startIntent=null;props.onImportComplete?.(run.runId);
  }catch(error){
   const reason=cancelled?'Import paused. Saved progress is retained.':message(error);patch({error:cancelled?null:reason,notice:cancelled?reason:null});
   try{const current=await props.storage.request(id(),'importRunStatus',{runId:run.runId});if(current.state!=='complete'&&current.state!=='cancelled'){const paused=await sendState({runId:run.runId,state:'paused',summary:{...current.summary,lastMessage:reason}});patch({selectedRun:paused});}else patch({selectedRun:current});}catch{/* An unknown outcome remains recoverable from the persisted run list. */}
  }finally{patch({busy:false});await loadRuns();if(!disposed&&state.selectedRun){const groups=await props.storage.request(id(),'importRunReadGroups',{runId:state.selectedRun.runId,page:budget});patch({groups:groups.items as unknown as ImportWorkGroup[],groupsCursor:groups.nextCursor});}}
 }
 async function discard(run:ImportRun):Promise<void>{
  cancelled=false;patch({busy:true,discarding:true,error:null,notice:'Discarding unfinished work…'});
  try{const operationId=typeof run.summary.discardOperationId==='string'?run.summary.discardOperationId:id();const result=await discardUnfinishedImport(runtime(),{runId:run.runId,operationId});patch({selectedRun:result,notice:'Unfinished work discarded. Saved conversations and original files are retained.'});await releaseSelected();startIntent=null;}
  catch(error){patch({error:message(error),notice:'Saved discard progress can be resumed from this import.'});}
  finally{patch({busy:false,discarding:false});await loadRuns();if(!disposed)await selectRun(run.runId);}
 }
 const controller={
  subscribe(listener:()=>void){listeners.add(listener);return()=>listeners.delete(listener);},getSnapshot:()=>state,
  async initialize(){if(disposed)return;unsubscribe??=props.storage.onChange(()=>{void loadRuns();});await loadRuns();try{const result=await props.storage.request(id(),'diagnostics',null);patch({availableBytes:result.quota!==null&&result.usage!==null?Math.max(0,result.quota-result.usage):null});}catch{/* Storage itself reports actionable errors during execution. */}
   try{const capability=(await props.host.capabilities()).extensionTransfers;const bridge=props.host.extensionBridge;if(disposed)return;
    patch({extension:{...state.extension,capability,pairingCode:bridge&&capability.available?bridge.pairingCode():null}});
    if(bridge&&capability.available&&!extensionUnsubscribe.length)extensionUnsubscribe=[
     bridge.onOffer(offer=>{if(state.extension.offer){void bridge.reject(id(),offer.offerId,'Another extension offer is already pending on this page.');return;}patch({extension:{...state.extension,offer,progress:null},error:null,notice:`The Quixi extension offers ${offer.bundle.file.name} (${offer.bundle.provider==='openai'?'ChatGPT':'Claude'}). Accept it to import.`});}),
     bridge.onProgress(progress=>{if(state.extension.offer?.offerId===progress.offerId)patch({extension:{...state.extension,progress}});}),
    ];
   }catch{/* Hosts without the capability report it explicitly; nothing to subscribe. */}},
  loadRuns,selectRun,
  async chooseFile(){if(state.busy||state.choosing)return;patch({choosing:true,error:null});try{const files=await props.host.chooseFiles(id(),{multiple:false,mediaTypes:['application/json','application/zip','application/x-zip-compressed','text/plain']});if(disposed){for(const file of files)await props.host.releaseFile(id(),file.id);return;}if(!files.length)return;await releaseSelected();selected=files[0]!;for(const extra of files.slice(1))await props.host.releaseFile(id(),extra.id);if(selected.byteLength===null){await releaseSelected();throw new Error('Choose a local file with a known size');}patch({selectedFile:selected});}catch(error){patch({error:message(error)});}finally{patch({choosing:false});}},
  async clearFile(){if(state.busy)return;try{await releaseSelected();}catch(error){patch({error:message(error)});}},
  async start(provider:'openai'|'anthropic',accountScope:string){if(active||disposed)return;if(!selected){patch({error:'Choose an export file first.'});return;}if(!accountScope.trim()||accountScope.length>256){patch({error:'Enter a source account label, up to 256 characters.'});return;}
   if(!startIntent)startIntent={provider,args:{operationId:id(),runId:id(),workspaceId:props.workspaceId,accountScope:accountScope.trim(),recordedAt:Date.now()}};
   if(startIntent.provider!==provider||startIntent.args.accountScope!==accountScope.trim()){patch({error:'The previous start may have been saved. Retry with its original provider and account label, or select that saved import to resume it.'});return;}
   const intent=startIntent;patch({busy:true,error:null});active=(async()=>{try{const run=await(intent.provider==='openai'?beginChatgptImport:beginClaudeImport)(runtime(),intent.args);startIntent=null;await execute(run,/\.zip$/i.test(selected!.name)||['application/zip','application/x-zip-compressed'].includes(selected!.mediaType??'')?'zip':'json',selected!.name);}catch(error){patch({error:message(error),busy:false});await loadRuns();}})();try{await active;}finally{active=null;}
  },
  async resume(runId:string){if(active||disposed)return;patch({busy:true,error:null});active=(async()=>{try{const run=await props.storage.request(id(),'importRunStatus',{runId});if(run.workspaceId!==props.workspaceId)throw new Error('This import belongs to another workspace');if(typeof run.summary.discardOperationId==='string'){await discard(run);return;}const format=run.summary.format==='zip'?'zip':'json';await execute(run,format,String(run.summary.sourceName??selected?.name??'conversations.json'));}catch(error){patch({error:message(error),busy:false});await loadRuns();}})();try{await active;}finally{active=null;}},
  async discard(runId:string){if(active||disposed)return;active=(async()=>{try{const run=await props.storage.request(id(),'importRunStatus',{runId});if(run.workspaceId!==props.workspaceId)throw new Error('This import belongs to another workspace');await discard(run);}catch(error){patch({error:message(error)});}})();try{await active;}finally{active=null;}},
  pause(){if(active&&!state.discarding){cancelled=true;patch({notice:'Pausing after the current step…'});}},
  /** Accept the pending extension offer: the host stages and verifies the bundle, then it imports like a chosen file under the bundle's provider. */
  async acceptOffer(accountScope:string){
   const bridge=props.host.extensionBridge,offer=state.extension.offer;if(!bridge||!offer||active||disposed)return;
   if(!accountScope.trim()||accountScope.length>256){patch({error:'Enter a source account label, up to 256 characters, before accepting.'});return;}
   extensionOffer={offer,accountScope:accountScope.trim()};patch({busy:true,error:null,notice:'Receiving from the extension…'});
   active=(async()=>{
    let file:HostFile|null=null;
    try{file=await bridge.accept(id(),offer.offerId);}
    catch(error){patch({error:message(error),busy:false,extension:{...state.extension,offer:null}});extensionOffer=null;return;}
    if(disposed){await props.host.releaseFile(id(),file.id);return;}
    await releaseSelected();selected=file;patch({selectedFile:file,notice:`Received ${file.name}; importing.`});
    const provider=offer.bundle.provider;
    startIntent={provider,args:{operationId:id(),runId:id(),workspaceId:props.workspaceId,accountScope:accountScope.trim(),recordedAt:Date.now()}};
    let outcome:'complete'|'failed'|'paused'='failed',runId:string|null=null,reason:string|null=null;
    try{const run=await(provider==='openai'?beginChatgptImport:beginClaudeImport)(runtime(),startIntent.args);runId=run.runId;startIntent=null;
     await execute({...run,summary:{...run.summary,method:'extension',bundleId:offer.bundle.bundleId,extractor:offer.bundle.extractor.name,extractorSource:offer.bundle.extractor.source,discovered:offer.bundle.discovered,sourceUrl:offer.bundle.sourceUrl}},offer.bundle.file.mediaType==='application/zip'?'zip':'json',file.name);
     const latest=await props.storage.request(id(),'importRunStatus',{runId:run.runId});outcome=latest.state==='complete'?'complete':latest.state==='paused'?'paused':'failed';reason=typeof latest.summary.lastMessage==='string'?latest.summary.lastMessage:null;}
    catch(error){reason=message(error);patch({error:reason,busy:false});await loadRuns();}
    finally{try{await bridge.report(id(),offer.offerId,{runId,outcome,reason});}catch{/* the extension may have gone away */}extensionOffer=null;patch({extension:{...state.extension,offer:null,progress:null}});}
   })();try{await active;}finally{active=null;}
  },
  async rejectOffer(){const bridge=props.host.extensionBridge,offer=state.extension.offer;if(!bridge||!offer)return;try{await bridge.reject(id(),offer.offerId,'Declined on the Quixi page.');}catch(error){patch({error:message(error)});}patch({extension:{...state.extension,offer:null,progress:null},notice:'Extension offer declined.'});},
  async cancelTransfer(){const bridge=props.host.extensionBridge,offer=state.extension.offer;if(!bridge||!offer)return;try{await bridge.cancel(id(),offer.offerId);}catch(error){patch({error:message(error)});}},
  async moreGroups(){const run=state.selectedRun,epoch=queryEpoch;if(!run||!state.groupsCursor)return;try{const result=await props.storage.request(id(),'importRunReadGroups',{runId:run.runId,page:{...budget,cursor:state.groupsCursor}});if(epoch!==queryEpoch||state.selectedRun?.runId!==run.runId)return;patch({groups:result.items as unknown as ImportWorkGroup[],groupsCursor:result.nextCursor});}catch(error){patch({error:message(error)});}},
  async warnings(group:ImportWorkGroup,cursor:string|null=null){const epoch=queryEpoch;const threadId=group.report.threadId,importSourceId=group.report.importSourceId;if(typeof threadId!=='string'||typeof importSourceId!=='string'){patch({warnings:[],warningsCursor:null,warningGroup:group});return;}try{const result=await props.storage.request(id(),'readEntities',{collection:'events',threadId,page:{maxItems:64,maxBytes:900_000,cursor}});if(epoch!==queryEpoch)return;patch({warnings:(result.items as JsonObject[]).filter(item=>(item.details as JsonObject)?.importSourceId===importSourceId),warningsCursor:result.nextCursor,warningGroup:group});}catch(error){patch({error:message(error)});}},
  async prepareReport(){if(!state.selectedRun||state.reportBusy)return;patch({reportBusy:true,error:null});try{await releaseReport();const runId=state.selectedRun.runId;const report=await prepareImportReport(runtime(),props.host,runId);if(disposed)await props.host.releaseTransfer(id(),report.transferId);else patch({report:{...report,runId}});}catch(error){patch({error:`Report could not be prepared: ${message(error)} The saved import report remains available.`});}finally{patch({reportBusy:false});}},
  async saveReport(){const report=state.report;if(!report)return;try{await props.host.saveFileTransfer(id(),{name:`quixi-import-${report.runId}.ndjson`,mediaType:'application/x-ndjson',transferId:report.transferId});await releaseReport();patch({notice:'Import report saved.'});}catch(error){patch({error:message(error)});}},
  async dispose(){if(disposed)return;cancelled=true;disposed=true;unsubscribe?.();unsubscribe=null;for(const off of extensionUnsubscribe)off();extensionUnsubscribe=[];listeners.clear();await active?.catch(()=>{});await Promise.allSettled([releaseSelected(),releaseReport()]);},
 };
 return controller;
}
export type ImportController=ReturnType<typeof createImportController>;
