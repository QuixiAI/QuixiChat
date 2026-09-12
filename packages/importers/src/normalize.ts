import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import type {ImportWorkGroup,ImportWorkItem,StagedImportRecord} from '@quixi/core/contracts';
import type {Attachment,ContentPart,JsonObject,JsonValue,Message,Role,SourceIdentity,Thread,ThreadState} from '@quixi/core/model';
import {ImportSession,WorkCheckpoint} from './storage.ts';
import {hashRange,contentFingerprint} from './bytes.ts';
import {upload} from './upload.ts';
import {jsonEvents} from './json/tokens.ts';
import {ScalarCollector} from './json/metadata.ts';
import {chatgptNodeWorkKey} from './chatgpt-scan.ts';
import type {ImportByteSource} from './types.ts';

const page={maxItems:128,maxBytes:900_000,cursor:null};
const object=(value:JsonValue|undefined):JsonObject=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const text=(value:JsonValue|undefined):string|null=>typeof value==='string'&&value.length?value:null;
const digest=(value:unknown)=>bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
const timestamp=(value:JsonValue|undefined):number|null=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&Number.isSafeInteger(Math.round(value*1000))?Math.round(value*1000):null;
const controlKey='control';
export const chatgptControlRecord=(byteStart:number,byteEnd:number)=>({key:controlKey,parentKey:null,byteStart,byteEnd,payload:{kind:'control'}});
type RecordInput={ [K in StagedImportRecord['collection']]:{collection:K;record:Extract<StagedImportRecord,{collection:K}>['record']} }[StagedImportRecord['collection']];
interface Plan extends JsonObject {threadId:string;importId:string;importSourceId:string;contextId:string;mode:'create'|'extend';expectedRevision:number|null;nativeThread:string;sourceThreadId:string|null;threadContainer:string;identityMethod:'native'|'fingerprint';fingerprint:string;initialized:boolean;skip:boolean}

class ThreadNormalizer {
 constructor(readonly session:ImportSession,readonly source:ImportByteSource,readonly rawObjectId:string,readonly group:ImportWorkGroup,readonly control:WorkCheckpoint,readonly plan:Plan){}
 private key(...parts:unknown[]):string{return JSON.stringify([this.group.groupKey,...parts]);}
 async id(...parts:unknown[]):Promise<string>{return this.session.id(this.key(...parts));}
 async operation(...parts:unknown[]):Promise<string>{return this.session.operation(this.key(...parts));}
 scope(kind:SourceIdentity['entityKind'],nativeId:string,container:string){return{provider:this.session.run.provider,accountScope:this.session.run.accountScope,sourceThreadId:this.plan.sourceThreadId,sourceContainerKey:this.plan.sourceThreadId===null?JSON.stringify([this.plan.nativeThread,container]):container,entityKind:kind,nativeId};}
 async identity(kind:SourceIdentity['entityKind'],nativeId:string,container:string,quixiId:string):Promise<RecordInput>{return{collection:'sourceIdentities',record:{...this.scope(kind,nativeId,container),id:await this.id('identity',kind,nativeId,container),quixiId}};}
 async provenance(kind:SourceIdentity['entityKind'],entityId:string,locator:string,created:JsonValue|undefined,compatibility:string[]=[]):Promise<RecordInput>{return{collection:'provenance',record:{id:await this.id('provenance',kind,entityId),entityKind:kind,entityId,importSourceId:this.plan.importSourceId,rawObjectId:this.rawObjectId,locator,sourceCreatedAtText:created===undefined||created===null?null:String(created),compatibility}};}
 async warning(key:string,messageId:string|null,code:string,details:JsonObject):Promise<RecordInput>{return{collection:'events',record:{id:await this.id('warning',key,code),threadId:this.plan.threadId,type:'ImportWarning',createdAt:null,recordedAt:this.session.run.recordedAt,messageId,generationId:null,details:{code,importSourceId:this.plan.importSourceId,...details}}};}
 async stage(work:WorkCheckpoint,slot:string,records:RecordInput[]):Promise<void>{
  if(!records.length)return;let sequence=work.data[slot];
  if(sequence===undefined){const status=await this.session.request('normalizedImportStatus',{importId:this.plan.importId});sequence=status.nextSequence;await work.save({...work.data,[slot]:sequence});}
  const ids=await this.session.ids(...records.map((record,index)=>this.key('record-operation',work.key,slot,index,record.collection)));
  const entries=records.map((record,index)=>({...record,operationId:ids[index]!,recordedAt:this.session.run.recordedAt})) as StagedImportRecord[];
  await this.session.request('stageImportRecords',{operationId:await this.operation('stage',work.key,slot),importId:this.plan.importId,sequence:Number(sequence),records:entries});
 }
 async initialize():Promise<void>{
  const {plan}=this;if(plan.initialized)return;
  await this.session.request('beginNormalizedImport',{operationId:await this.operation('begin'),importId:plan.importId,threadId:plan.threadId,mode:plan.mode,expectedThreadRevision:plan.expectedRevision,recordedAt:this.session.run.recordedAt});
  const records:RecordInput[]=[{collection:'importSources',record:{id:plan.importSourceId,provider:this.session.run.provider,method:'provider_export',sourceThreadId:plan.sourceThreadId,sourceUrl:null,importerName:this.session.run.importerName,importerVersion:this.session.run.importerVersion,sourceFormatVersion:this.session.run.formatProfile,sourceFingerprint:plan.fingerprint,importedAt:this.session.run.recordedAt}}];
  if(plan.mode==='create'){
   records.push({collection:'threads',record:{id:plan.threadId,workspaceId:this.session.run.workspaceId,createdAt:timestamp(object(this.group.metadata.fields).create_time),recordedAt:this.session.run.recordedAt,systemPrompt:null,preferredRoute:null,importSourceId:plan.importSourceId}},{collection:'contexts',record:{id:plan.contextId,threadId:plan.threadId,previousId:null,version:1,systemPrompt:null,preferredRoute:null,recordedAt:this.session.run.recordedAt}},await this.identity('thread',plan.nativeThread,plan.threadContainer,plan.threadId));
  }
  records.push(await this.identity('thread',plan.nativeThread,`thread-observation:${plan.fingerprint}`,plan.threadId),await this.provenance('thread',plan.threadId,String(this.group.metadata.locator),object(this.group.metadata.fields).create_time,['provider_export_shape_observed_not_complete_official_schema']));
  if(plan.identityMethod==='fingerprint')records.push(await this.warning('thread-identity',null,'heuristic_thread_identity',{method:'content_fingerprint',reason:'No provider-native thread ID or independently unique stable metadata is present; changed content may require user reconciliation'}));
  if(Array.isArray(this.group.metadata.truncated)&&this.group.metadata.truncated.length)records.push(await this.warning('thread-metadata',null,'metadata_display_truncated',{fields:this.group.metadata.truncated}));
  await this.stage(this.control,'initialSequence',records);plan.initialized=true;await this.control.save({...this.control.data,plan});
 }
 async resolve(item:ImportWorkItem,canonicalId:string|null,data:JsonObject):Promise<void>{await this.session.request('importWorkResolve',{operationId:await this.operation('resolve',item.key),runId:this.session.run.runId,groupKey:this.group.groupKey,key:item.key,result:{canonicalId,data}});}
 async node(item:ImportWorkItem):Promise<void>{
  const payload=item.payload,fields=object(payload.fields),parentId=item.parentResult?.canonicalId??null;
  if(!payload.messageObject){await this.resolve(item,parentId,{structural:true});return;}
  const role=text(fields['message/author/role']);
  if(!['system','user','assistant','tool'].includes(role??'')){
   // A malformed message record is skipped with a visible warning rather than
   // failing the whole import: its raw bytes stay in the retained source, its
   // own parts are skipped, and its descendants attach to the nearest valid
   // ancestor exactly as a structural node's descendants do.
   await this.stage(WorkCheckpoint.from(this.session,this.group.groupKey,item),'recordSequence',[await this.warning(item.key,null,'malformed_record_skipped',{locator:String(payload.messageLocator??String(payload.locator)+'/message'),reason:'unsupported_or_missing_role',role:role??null,rawObjectId:this.rawObjectId})]);
   await this.resolve(item,parentId,{structural:true,malformed:true,skip:true});return;
  }
  const nativeId=text(fields['message/id'])??String(payload.nodeKey);const namespace=text(fields['message/id'])?'message':'mapping-node';
  const messageDigest=await hashRange(this.source,Number(payload.messageStart),Number(payload.messageEnd),this.session.runtime.cancelled);
  const revision=digest([messageDigest,parentId,role]),partScope=`message-parts:${digest([namespace,nativeId,revision])}`;const revisionScope=this.scope('message',nativeId,`${namespace}-revision:${revision}`);
  const existingRevision=await this.session.request('resolveSourceIdentity',{scope:revisionScope});
  if(existingRevision){await this.resolve(item,existingRevision,{skip:true,partScope,partCount:Number(payload.partCount),attachmentCount:Number(payload.attachmentCount)});return;}
  if(this.plan.skip)throw new Error('Existing source observation lacks its expected immutable message mapping');
  const previousId=await this.session.request('resolveSourceIdentity',{scope:this.scope('message',nativeId,namespace)});
  const previous=previousId?await this.session.request('readEntity',{collection:'messages',id:previousId}) as unknown as Message|null:null;
  const id=await this.id('message',item.key),partCount=Number(payload.partCount),attachmentCount=Number(payload.attachmentCount),fallback=partCount===0?1:0;
  const message:Message={id,threadId:this.plan.threadId,parentId,role:role as Role,createdAt:timestamp(fields['message/create_time']),recordedAt:this.session.run.recordedAt,generationId:null,editedFromMessageId:previous&&previous.parentId===parentId&&previous.role===role?previous.id:null,partCount:partCount+attachmentCount+fallback,sealed:true};
  const records:RecordInput[]=[{collection:'messages',record:message},await this.identity('message',nativeId,`${namespace}-revision:${revision}`,id),await this.provenance('message',id,String(payload.messageLocator??String(payload.locator)+'/message'),fields['message/source_created_at']??fields['message/create_time'],['generation_attempt_details_not_inferred'])];
  if(!previousId)records.push(await this.identity('message',nativeId,namespace,id));
  if(payload.parentInferred)records.push(await this.warning(item.key,id,'parent_inferred_from_export_order',{locator:String(payload.locator)}));
  if(previousId)records.push(await this.warning(item.key,id,'source_message_revision',{previousMessageId:previousId,editedFromLinked:message.editedFromMessageId!==null}));
  if(fallback)records.push({collection:'parts',record:{id:await this.id('fallback-part',item.key),messageId:id,order:0,kind:'ProviderArtifact',data:{providerKind:text(fields['message/content/content_type'])??'unknown-content',rawObjectId:this.rawObjectId,locator:String(payload.locator)+'/message/content'}}},await this.warning(item.key,id,'unsupported_or_empty_content',{locator:String(payload.locator)+'/message/content'}));
  await this.stage(WorkCheckpoint.from(this.session,this.group.groupKey,item),'recordSequence',records);
  await this.resolve(item,id,{skip:false,partScope,partCount,attachmentCount,fallback,contentType:text(fields['message/content/content_type'])});
 }
 async part(item:ImportWorkItem):Promise<void>{
  // A skipped parent (existing revision or malformed record) contributes no
  // parts, even when it sits at the root and has no canonical message at all.
  if(item.parentResult?.data.skip){await this.enrichAttachment(item);await this.resolve(item,null,{skip:true});return;}
  const messageId=item.parentResult?.canonicalId;if(!messageId)throw new Error('Part has no canonical message parent');
  const work=WorkCheckpoint.from(this.session,this.group.groupKey,item),attachment=item.payload.kind==='attachment';
  const order=Number(item.payload.index)+(attachment?Number(item.parentResult!.data.partCount)+Number(item.parentResult!.data.fallback??0):0);
  const id=await this.id('part',item.key),locator=String(item.payload.locator);let part:ContentPart;const records:RecordInput[]=[];
  if(attachment){
   const fields:JsonObject={};const collector=new ScalarCollector(path=>path.length===1&&['file_name','name','mime_type','mimeType','file_type','file_size','size'].includes(String(path[0])),(path,value)=>{fields[String(path[0])]=value;});
   for await(const event of jsonEvents(this.source.open(item.byteStart,item.byteEnd)))collector.accept(event);
   const attachmentId=await this.id('attachment',item.key),size=fields.file_size??fields.size;
   const filename=text(fields.file_name)??text(fields.name),mimeType=text(fields.mime_type)??text(fields.mimeType)??text(fields.file_type);
   const asset=filename?await this.session.runtime.assets?.resolve(filename):null;
   let blobSha256:string|null=null,sizeBytes=typeof size==='number'&&Number.isSafeInteger(size)&&size>=0?size:null;
   if(asset){const blob=await upload(work,'attachmentBlob','attachment',()=>asset.source.open(),asset.source.byteLength);await this.session.request('prepareImportBlobs',{operationId:await this.operation('prepare-attachment',item.key),importId:this.plan.importId,stagedBlobIds:[blob.transferId]});blobSha256=blob.sha256;if(sizeBytes!==null&&sizeBytes!==blob.byteLength)records.push(await this.warning(item.key,messageId,'attachment_size_metadata_mismatch',{declaredBytes:sizeBytes,actualBytes:blob.byteLength,locator}));sizeBytes=blob.byteLength;}
   records.push({collection:'attachments',record:{id:attachmentId,availability:asset?'available':'missing',filename,mimeType,sizeBytes,blobSha256,rawObjectId:asset?.rawObjectId??this.rawObjectId}});
   part={id,messageId,order,kind:mimeType?.startsWith('image/')?'Image':mimeType?.startsWith('audio/')?'Audio':'File',data:{attachmentId,description:null}};
   if(!asset)records.push(await this.warning(item.key,messageId,'attachment_bytes_missing',{attachmentId,locator}));
  }else{
   let inline='',length=0,kind:string|null=null,validUnicode=true,pendingHigh='';const claude=item.payload.providerShape==='claude';let claudeType:string|null=null,hasText=false;
   const shape:JsonObject={};const contentType=new ScalarCollector(path=>path.length===1&&['type','content_type','asset_pointer','size_bytes'].includes(String(path[0])),(path,value)=>{shape[String(path[0])]=value;if(path[0]==='type')claudeType=typeof value==='string'?value:null;});
   const textPath=(path:readonly(string|number)[])=>claude?path.length===1&&path[0]==='text':path.length===0;
   for await(const event of jsonEvents(this.source.open(item.byteStart,item.byteEnd))){
    if(kind===null)kind=event.kind;contentType.accept(event);if(event.kind==='stringStart'&&textPath(event.path))hasText=true;
    if(event.kind==='stringChunk'&&textPath(event.path)){length+=event.value.length;if(length<=16_384)inline+=event.value;else inline='';const value=pendingHigh+event.value;pendingHigh='';for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){if(i===value.length-1){pendingHigh=value[i]!;break;}const next=value.charCodeAt(++i);if(next<0xdc00||next>0xdfff)validUnicode=false;}else if(c>=0xdc00&&c<=0xdfff)validUnicode=false;}}
   }
   if(pendingHigh)validUnicode=false;
   if(hasText&&(kind==='stringStart'||(claude&&claudeType==='text'))&&validUnicode){
    if(length<=16_384)part={id,messageId,order,kind:'Text',data:{text:inline}};
    else{
     const source=this.source;const blob=await upload(work,'textBlob','canonical_text',async function*(){let high='';for await(const event of jsonEvents(source.open(item.byteStart,item.byteEnd))){if(event.kind!=='stringChunk'||!textPath(event.path))continue;let value=high+event.value;high='';const last=value.charCodeAt(value.length-1);if(last>=0xd800&&last<=0xdbff){high=value.slice(-1);value=value.slice(0,-1);}if(value)yield new TextEncoder().encode(value);}if(high)throw new Error('Unpaired UTF-16 surrogate');},null);
     await this.session.request('prepareImportBlobs',{operationId:await this.operation('prepare-text',item.key),importId:this.plan.importId,stagedBlobIds:[blob.transferId]});
     part={id,messageId,order,kind:'Text',data:{textBlob:{sha256:blob.sha256,byteLength:blob.byteLength,encoding:'utf-8'}}};
    }
   }else if(shape.content_type==='image_asset_pointer'&&typeof shape.asset_pointer==='string'){
    const pointer=shape.asset_pointer,assetKey=pointer.startsWith('sediment://')?pointer.slice('sediment://'.length):null,asset=assetKey?await this.session.runtime.assets?.resolve(assetKey):null;
    const attachmentId=await this.id('image-attachment',item.key);let blobSha256:string|null=null,sizeBytes=typeof shape.size_bytes==='number'&&Number.isSafeInteger(shape.size_bytes)&&shape.size_bytes>=0?shape.size_bytes:null;
    if(asset){const blob=await upload(work,'imageBlob','attachment',()=>asset.source.open(),asset.source.byteLength);await this.session.request('prepareImportBlobs',{operationId:await this.operation('prepare-image',item.key),importId:this.plan.importId,stagedBlobIds:[blob.transferId]});blobSha256=blob.sha256;sizeBytes=blob.byteLength;}
    records.push({collection:'attachments',record:{id:attachmentId,availability:asset?'available':'missing',filename:null,mimeType:null,sizeBytes,blobSha256,rawObjectId:asset?.rawObjectId??this.rawObjectId}});part={id,messageId,order,kind:'Image',data:{attachmentId,description:null}};
    if(!asset)records.push(await this.warning(item.key,messageId,'attachment_bytes_missing',{attachmentId,locator,assetPointer:pointer}));
   }else{
    part={id,messageId,order,kind:'ProviderArtifact',data:{providerKind:validUnicode?'unsupported-part':'unpaired-utf16-source-text',rawObjectId:this.rawObjectId,locator}};
    records.push(await this.warning(item.key,messageId,validUnicode?'unsupported_part_preserved':'source_text_not_valid_unicode',{locator}));
   }
  }
  records.unshift({collection:'parts',record:part});records.push(await this.identity('part',`${String(item.payload.kind)}:${String(item.payload.index)}`,String(item.parentResult!.data.partScope),id));records.push(await this.provenance('part',id,locator,undefined));
  await this.stage(work,'recordSequence',records);await this.resolve(item,id,{kind:part.kind});
 }
 async enrichAttachment(item:ImportWorkItem):Promise<void>{
  if(!this.session.runtime.assets)return;
  const partId=await this.session.request('resolveSourceIdentity',{scope:this.scope('part',`${String(item.payload.kind)}:${String(item.payload.index)}`,String(item.parentResult!.data.partScope))});
  if(!partId)throw new Error('Existing content lacks a stable source-part mapping; explicit reconciliation is required');
  const part=await this.session.request('readEntity',{collection:'parts',id:partId}) as unknown as ContentPart|null;
  if(!part||!['File','Image','Audio'].includes(part.kind))return;
  const attachmentId=(part as Extract<ContentPart,{kind:'File'|'Image'|'Audio'}>).data.attachmentId;
  const attachment=await this.session.request('readEntity',{collection:'attachments',id:attachmentId}) as unknown as Attachment|null;
  if(!attachment||attachment.availability==='available')return;let assetName=attachment.filename;
  if(!assetName){const metadata:JsonObject={};const collector=new ScalarCollector(path=>path.length===1&&path[0]==='asset_pointer',(path,value)=>{metadata[String(path[0])]=value;});for await(const event of jsonEvents(this.source.open(item.byteStart,item.byteEnd)))collector.accept(event);if(typeof metadata.asset_pointer==='string'&&metadata.asset_pointer.startsWith('sediment://'))assetName=metadata.asset_pointer.slice('sediment://'.length);}
  if(!assetName)return;const asset=await this.session.runtime.assets.resolve(assetName);if(!asset)return;
  const work=WorkCheckpoint.from(this.session,this.group.groupKey,item),blob=await upload(work,'resolvedAttachment','attachment',()=>asset.source.open(),asset.source.byteLength);
  const thread=await this.session.request('readEntity',{collection:'threads',id:this.plan.threadId}) as unknown as Thread|null;if(!thread?.importSourceId)throw new Error('Imported thread source provenance is missing');
  const provenance={id:await this.id('resolved-attachment-provenance',item.key),entityKind:'attachment' as const,entityId:attachmentId,importSourceId:thread.importSourceId,rawObjectId:asset.rawObjectId,locator:asset.locator,sourceCreatedAtText:null,compatibility:['attachment_bytes_resolved_from_later_selected_export']};
  await this.session.request('commit',{transactionId:await this.id('resolve-attachment-transaction',item.key),mutations:[{version:1,operationId:await this.operation('resolve-attachment',item.key),kind:'ResolveAttachment',recordedAt:this.session.run.recordedAt,payload:{attachmentId,blobSha256:blob.sha256,sizeBytes:blob.byteLength,provenance:[provenance]}}],expectedThreadRevisions:[],stagedBlobIds:[blob.transferId]});
 }
 async finish():Promise<void>{
  if(this.plan.skip){await this.session.request('importGroupFinish',{operationId:await this.operation('skip-enriched'),runId:this.session.run.runId,groupKey:this.group.groupKey,outcome:'skipped',normalizedImportId:null,report:{reason:'same_source_observation',threadId:this.plan.threadId,attachments:'missing_bytes_reconciled_by_exact_path',existingPublishedBytes:'retained_immutable'}});return;}
  if(this.plan.mode==='create'){
   const fields=object(this.group.metadata.fields),activeNode=text(fields.current_node),active=activeNode?await this.session.request('importWorkGet',{runId:this.session.run.runId,groupKey:this.group.groupKey,key:chatgptNodeWorkKey(activeNode)}):null;
   const state:ThreadState={threadId:this.plan.threadId,title:typeof fields.title==='string'?fields.title:'Imported conversation',tags:[],pinned:fields.is_starred===true,archived:fields.is_archived===true,activeLeafMessageId:active?.result?.canonicalId??null,contextSnapshotId:this.plan.contextId,routingProfile:null,revision:0};
   const records:RecordInput[]=[{collection:'threadStates',record:state}];
   if(activeNode&&!active?.result?.canonicalId)records.push(await this.warning('active-node',null,'active_branch_unresolved',{nativeId:activeNode}));
   await this.stage(this.control,'finalSequence',records);
  }
  let status=await this.session.request('normalizedImportStatus',{importId:this.plan.importId});
  while(status.state!=='ready'&&status.state!=='published'){
   const counter=Number(this.control.data.validationCounter??0);await this.control.save({...this.control.data,validationCounter:counter+1});
   await this.session.request('validateImportStep',{operationId:await this.operation('validate',counter),importId:this.plan.importId,maxRecords:128,stagedBlobIds:[]});
   status=await this.session.request('normalizedImportStatus',{importId:this.plan.importId});
  }
  if(status.state!=='published')await this.session.request('finalizeNormalizedImport',{operationId:await this.operation('publish'),importId:this.plan.importId,recordedAt:this.session.run.recordedAt,expectedRecordCount:status.recordCount,expectedManifestDigest:status.manifestDigest});
  await this.session.request('importWorkResolve',{operationId:await this.operation('resolve-control'),runId:this.session.run.runId,groupKey:this.group.groupKey,key:controlKey,result:{canonicalId:this.plan.threadId,data:{published:true}}});
  await this.session.request('importGroupFinish',{operationId:await this.operation('finish'),runId:this.session.run.runId,groupKey:this.group.groupKey,outcome:'published',normalizedImportId:this.plan.importId,report:{threadId:this.plan.threadId,importSourceId:this.plan.importSourceId,mode:this.plan.mode,records:status.recordCount,sourceFingerprint:this.plan.fingerprint}});
 }
}

export async function normalizeChatgptGroup(session:ImportSession,source:ImportByteSource,rawObjectId:string,group:ImportWorkGroup):Promise<void>{
 if(group.state!=='sealed')return;
 const controlItem=await session.request('importWorkGet',{runId:session.run.runId,groupKey:group.groupKey,key:controlKey});if(!controlItem)throw new Error('Import control checkpoint missing');
 const control=WorkCheckpoint.from(session,group.groupKey,controlItem);let plan=control.data.plan as Plan|undefined;
 if(!plan){
  const fields=object(group.metadata.fields),sourceThreadId=text(fields.conversation_id)??text(fields.id);
  const nativeThread=sourceThreadId??await contentFingerprint(source,Number(group.metadata.byteStart),Number(group.metadata.byteEnd));const threadContainer=sourceThreadId===null?'fingerprint-thread':'thread';
  const fingerprint=await hashRange(source,Number(group.metadata.byteStart),Number(group.metadata.byteEnd),session.runtime.cancelled);
  const scope={provider:session.run.provider,accountScope:session.run.accountScope,sourceThreadId,sourceContainerKey:sourceThreadId===null?JSON.stringify([nativeThread,threadContainer]):threadContainer,entityKind:'thread' as const,nativeId:nativeThread};
  const existing=await session.request('resolveSourceIdentity',{scope}),seen=await session.request('resolveSourceIdentity',{scope:{...scope,sourceContainerKey:sourceThreadId===null?JSON.stringify([nativeThread,`thread-observation:${fingerprint}`]):`thread-observation:${fingerprint}`}});
  const ids=await session.ids(...['thread','normalized-import','import-source','context'].map(kind=>JSON.stringify([group.groupKey,kind])));
  const state=existing?await session.request('readEntity',{collection:'threadStates',id:existing}) as unknown as ThreadState|null:null;
  plan={threadId:existing??ids[0]!,importId:ids[1]!,importSourceId:ids[2]!,contextId:ids[3]!,mode:existing?'extend':'create',expectedRevision:state?.revision??null,nativeThread,sourceThreadId,threadContainer,identityMethod:sourceThreadId===null?'fingerprint':'native',fingerprint,initialized:false,skip:seen!==null};await control.save({...control.data,plan});
 }
 if(plan.skip&&!session.runtime.assets){await session.request('importGroupFinish',{operationId:await session.operation(JSON.stringify([group.groupKey,'skip'])),runId:session.run.runId,groupKey:group.groupKey,outcome:'skipped',normalizedImportId:null,report:{reason:'same_source_observation',threadId:plan.threadId}});return;}
 const normalizer=new ThreadNormalizer(session,source,rawObjectId,group,control,plan);if(!plan.skip)await normalizer.initialize();
 // The control row remains pending until publication so final stage and validation counters survive lost replies.
 let processedMessages=0,processedParts=0;
 while(true){
  const ready=await session.request('importWorkRead',{runId:session.run.runId,groupKey:group.groupKey,state:'ready',page});
  const item=ready.items.find(value=>value.key!==controlKey);
  if(!item){const current=await session.request('importWorkGroupStatus',{runId:session.run.runId,groupKey:group.groupKey});if(!current||current.recordCount-current.resolvedCount>1)throw new Error(`Import dependency graph is incomplete or cyclic (${ready.blocked??'unresolved dependencies'})`);break;}
  if(item.payload.kind==='node'){await normalizer.node(item);if(item.payload.messageObject)processedMessages++;}else if(item.payload.kind==='part'||item.payload.kind==='attachment'){await normalizer.part(item);processedParts++;}else throw new Error('Unknown importer work kind');
  if((processedMessages+processedParts)%32===0)session.runtime.onProgress?.({runId:session.run.runId,phase:'normalizing',processedBytes:Number(group.metadata.byteStart),totalBytes:source.byteLength,groups:0,messages:processedMessages,parts:processedParts});
 }
 await normalizer.finish();
}
