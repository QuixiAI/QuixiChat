import { SUMMARY_INSTRUCTION } from '@quixi/core/model';
import type { Generation, SummaryProposal } from '@quixi/core/model';
import type { BlobCatalog } from '../../src/worker/blob-catalog.ts';
import { summarySourceInfo, summaryTextDigest } from '../../src/worker/canonical/summary-source.ts';
import type { ArchiveRepository } from '../../src/worker/archives/index.ts';
import type { ArchiveSqlite, ArchiveDatabaseFile } from '../../src/worker/archives/snapshot.ts';
import { sqlRows } from '../../src/worker/archives/snapshot.ts';
import type { CanonicalRepository } from '../../src/worker/canonical/repository.ts';
import type { CanonicalMutation } from '@quixi/core/contracts';
import { canonicalJson } from '@quixi/core/contracts';

/** Separate from the schema-8 fixture: schema-11 policy must never masquerade as schema 8. */
export async function compactionRoundtrip(jobs:ArchiveRepository, sqlite:ArchiveSqlite, source:ArchiveDatabaseFile, canonical:CanonicalRepository, threadId:string, digest:string, byteLength:number, catalog:BlobCatalog) {
 const id=()=>crypto.randomUUID(), now=Date.now(), attachmentId=id(),messageId=id(),partId=id();
 const previous=canonical.get('contexts',canonical.get('threadStates',threadId)!.contextSnapshotId)!;
 const context={...previous,id:id(),previousId:previous.id,version:previous.version+1,recordedAt:now,compaction:{version:1 as const,excludedPartIds:[partId]}};
 const routingProfile={version:5,alias:'Portable cost and region limits',primary:{provider:'synthetic-primary',model:'primary-model'},candidates:[{provider:'synthetic-fallback',model:'fallback-model'}],requirements:{maxRequestCost:'0.25',maxEstimatedRequestCost:'0.5',processingRegion:'us'},allowPrivacyChange:false};
 const mutation=(kind:CanonicalMutation['kind'],payload:unknown)=>({version:1,operationId:id(),kind,payload,recordedAt:now}) as CanonicalMutation;
 canonical.commit({transactionId:id(),expectedThreadRevisions:[],stagedBlobIds:[],mutations:[
  mutation('SetRoutingProfile',{threadId,value:routingProfile}),
  mutation('RegisterAttachment',{attachment:{id:attachmentId,availability:'available',filename:'original-context.txt',mimeType:'text/plain',sizeBytes:byteLength,blobSha256:digest,rawObjectId:null}}),
  mutation('CreateMessage',{message:{id:messageId,threadId,parentId:null,role:'user',createdAt:now,recordedAt:now,generationId:null,editedFromMessageId:null,partCount:1,sealed:true},parts:[{id:partId,messageId,order:0,kind:'File',data:{attachmentId,description:'original description'}}]}),
  mutation('CreateContextSnapshot',{context,select:true}),
  mutation('CreateThreadEvent',{event:{id:id(),threadId,type:'ContextCompaction',messageId,generationId:null,createdAt:now,recordedAt:now,details:{action:'exclude_attachments',contextSnapshotId:context.id,excludedPartIds:[partId]}}}),
 ]});
 // A distinct ordinary user tail makes the cutoff explicit; the summary attempt is
 // retained as a separate purpose and never selected as an ordinary answer.
 const tailId=id();
 canonical.commit({transactionId:id(),expectedThreadRevisions:[],stagedBlobIds:[],mutations:[
  mutation('CreateMessage',{message:{id:tailId,threadId,parentId:messageId,role:'user',createdAt:now,recordedAt:now,generationId:null,editedFromMessageId:null,partCount:1,sealed:true},parts:[{id:id(),messageId:tailId,order:0,kind:'Text',data:{text:'Retained current user request'}}]}),
  mutation('SetActiveBranch',{threadId,value:tailId}),
 ]});
 const state=canonical.get('threadStates',threadId)!;
 const frozenBody=JSON.stringify({system:SUMMARY_INSTRUCTION,messages:[{role:'user',content:'[Attachment omitted by your context choice.]'}]}),inputBytes=new TextEncoder().encode(frozenBody),inputSha256=summaryTextDigest(frozenBody),inputId=id();
 const stage=await catalog.begin({operationId:id(),purpose:'canonical_text',expectedBytes:inputBytes.length,expectedSha256:inputSha256},id);
 catalog.append({transferId:stage.transferId,sequence:0,offset:0,bytes:inputBytes,final:true});
 await catalog.finish({operationId:id(),transferId:stage.transferId,expectedBytes:inputBytes.length,expectedSha256:inputSha256});await catalog.preparePublication([stage.transferId]);
 const request={...context,id:id(),previousId:context.id,version:context.version+1,systemPrompt:SUMMARY_INSTRUCTION};
 delete (request as {compaction?:unknown}).compaction;
 canonical.commit({transactionId:id(),expectedThreadRevisions:[{threadId,revision:state.revision}],stagedBlobIds:[stage.transferId],mutations:[
  mutation('RegisterRawObject',{rawObject:{id:inputId,availability:'available',sha256:inputSha256,byteLength:inputBytes.length,mediaType:'application/vnd.quixi.summary-input+json',storageRef:'sha256:'+inputSha256}}),
  mutation('CreateContextSnapshot',{context:request,select:false}),
 ]});await catalog.consumeAfterCommit([stage.transferId]);
 const generation:Generation={id:id(),threadId,parentMessageId:messageId,outputMessageId:id(),contextSnapshotId:request.id,purpose:'context_summary',provider:'synthetic-proof',providerAccountId:null,model:'authored-fixture',parameters:{},status:'complete',createdAt:now,recordedAt:now,completedAt:now,tokensIn:10,tokensOut:5,cachedTokens:null,estimatedCost:null,reportedCost:null,lastSequence:0,rawResponseId:null,compatibility:[]};
 const proposal:SummaryProposal={version:1,id:id(),threadId,recordedAt:now,generationId:generation.id,sourceContextSnapshotId:context.id,requestContextSnapshotId:request.id,throughMessageId:messageId,sourceLeafMessageId:tailId,sourceThreadRevision:state.revision,baseSummaryProposalId:null,baseSummaryContextId:null,...summarySourceInfo(source,context.id,messageId),inputRawObjectId:inputId,inputSha256,inputByteLength:inputBytes.length,promptTemplateVersion:1};
 canonical.commit({transactionId:id(),expectedThreadRevisions:[],stagedBlobIds:[],mutations:[
  mutation('CreateGeneration',{generation,output:{id:generation.outputMessageId,threadId,parentId:messageId,role:'assistant',createdAt:now,recordedAt:now,generationId:generation.id,editedFromMessageId:null,partCount:1,sealed:true},parts:[{id:id(),messageId:generation.outputMessageId,order:0,kind:'Text',data:{text:'Authored proposal: the attachment was explicitly excluded.'}}]}),
  mutation('RegisterSummaryProposal',{proposal}),
 ]});
 const reviewedText='Reviewed correction: do not infer the excluded attachment contents.';
 const summarized={...context,id:id(),previousId:context.id,version:context.version+1,compaction:{version:2,excludedPartIds:[partId],summary:{proposalId:proposal.id,throughMessageId:messageId,reviewedText,reviewedTextSha256:summaryTextDigest(reviewedText)}}};
 canonical.commit({transactionId:id(),expectedThreadRevisions:[{threadId,revision:state.revision}],stagedBlobIds:[],mutations:[
  mutation('CreateContextSnapshot',{context:summarized,select:true}),
  mutation('CreateThreadEvent',{event:{id:id(),threadId,type:'ContextCompaction',messageId,generationId:generation.id,createdAt:now,recordedAt:now,details:{action:'apply_summary',contextSnapshotId:summarized.id,proposalId:proposal.id}}}),
 ]});
 const branchSource=canonical.get('threadStates',threadId)!,fresh={...summarized,id:id(),previousId:summarized.id,version:summarized.version+1,recordedAt:now,compaction:{...summarized.compaction,summary:null}},branchEventId=id();
 canonical.commit({transactionId:id(),expectedThreadRevisions:[{threadId,revision:branchSource.revision}],stagedBlobIds:[],mutations:[
  mutation('CreateContextSnapshot',{context:fresh,select:true}),
  mutation('SetActiveBranch',{threadId,value:null}),
  mutation('CreateThreadEvent',{event:{id:branchEventId,threadId,type:'ContextCompaction',messageId:tailId,generationId:null,createdAt:now,recordedAt:now,details:{version:1,action:'start_branch',retainedContext:'system_prompt_only',sourceThreadRevision:branchSource.revision,sourceLeafMessageId:tailId,previousContextSnapshotId:summarized.id,contextSnapshotId:fresh.id}}}),
 mutation('CreateThreadEvent',{event:{id:id(),threadId,type:'ContextCompaction',messageId:tailId,generationId:null,createdAt:now,recordedAt:now,details:{action:'clear_summary',contextSnapshotId:fresh.id,previousContextSnapshotId:summarized.id,reason:'start_branch'}}}),
 ]});
 if(canonicalJson(canonical.get('threadStates',threadId)!.routingProfile)!==canonicalJson(routingProfile))throw new Error('Fresh branch changed the version-5 routing profile or its cost and processing region limits');
 let exported=await jobs.request('beginArchiveExport',{operationId:id(),format:'portable'});
 for(let step=0;exported.state==='working'&&step<10000;step++)exported=await jobs.request('advanceArchiveJob',{operationId:id(),jobId:exported.jobId,maxRecords:16,maxBytes:65536});
 if(exported.state!=='ready')throw new Error('Compaction export failed');
 const download=await jobs.request('openArchiveExport',{jobId:exported.jobId});
 const restore=await jobs.request('beginArchiveRestore',{operationId:id(),expectedBytes:download.byteLength,expectedSha256:download.sha256});
 for(let step=0;step<10000;step++){
  const chunk=jobs.readChunk(download.transferId);
  await jobs.append({...chunk,transferId:restore.inputTransfer.transferId});
  jobs.acknowledge({transferId:chunk.transferId,sequence:chunk.sequence,committedOffset:chunk.offset+chunk.bytes.length});
  if(chunk.final)break;
  if(step===9999)throw new Error('Compaction transfer exceeded limit');
 }
 let status=await jobs.request('finishArchiveRestore',{operationId:id(),jobId:restore.job.jobId,byteLength:download.byteLength,sha256:download.sha256});
 for(let step=0;status.state==='working'&&step<10000;step++)status=await jobs.request('advanceArchiveJob',{operationId:id(),jobId:status.jobId,maxRecords:16,maxBytes:65536});
 if(status.state!=='ready'||!status.candidate)throw new Error(`Compaction restore failed: ${JSON.stringify(status)}`);
 // Release job handles before taking the read-only candidate connection.
 await jobs.close();
 const restoredPool=await sqlite.installOpfsSAHPoolVfs({name:`compaction-check-${id()}`,directory:`/quixi-${status.candidate.archiveId}/database`,initialCapacity:6});
 try{
  const restored=new restoredPool.OpfsSAHPoolDb('/archive.sqlite3','r');
  try{
   for(const sql of ['SELECT collection,id,payload FROM quixi_records ORDER BY collection,id','SELECT * FROM quixi_edges ORDER BY 1,2,3','SELECT * FROM quixi_sync_ops ORDER BY sequence'])
    if(JSON.stringify(sqlRows(source,sql))!==JSON.stringify(sqlRows(restored,sql)))throw new Error('Compaction canonical data, references or journal changed in roundtrip');
   if(restored.selectValue('PRAGMA integrity_check')!=='ok')throw new Error('Compaction restored integrity failed');
   const restoredState=JSON.parse(String(restored.selectValue("SELECT payload FROM quixi_records WHERE collection='threadStates' AND id=?",[threadId]))) as {activeLeafMessageId:string|null;contextSnapshotId:string;routingProfile:typeof routingProfile};
   if(restoredState.activeLeafMessageId!==null||restoredState.contextSnapshotId!==fresh.id)throw new Error('Fresh branch empty selection changed during portable restore');
   if(canonicalJson(restoredState.routingProfile)!==canonicalJson(routingProfile))throw new Error('Version-5 routing profile or cost and processing region limits changed during portable restore');
  }finally{restored.close();}
 }finally{restoredPool.pauseVfs();}
 return {schemaVersion:status.candidate.schemaVersion,contextId:context.id,summaryContextId:summarized.id,summaryProposalId:proposal.id,frozenInputSha256:inputSha256,partId,freshBranchContextId:fresh.id,branchEventId,emptySelectedBranch:true,routingProfile,archiveBytes:download.byteLength,canonicalAndJournalExact:true};
}
