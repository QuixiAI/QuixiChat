import corpus from './quality-fixtures.json' with { type:'json' };
/** Corpus consistency only. This intentionally does not grade free-form model summaries. */
export function validateCorpus(value:typeof corpus=corpus){
 const seen=new Set<string>();let claims=0,controls=0;
 if(value.version!==1||value.modelRuns!==0)throw new Error('This is an authored corpus, not a model-run report');
 for(const fixture of value.fixtures){
  if(seen.has(fixture.id))throw new Error('Duplicate fixture');seen.add(fixture.id);
  const cut=fixture.messages.findIndex(message=>message.id===fixture.throughMessageId);
  if(cut<0||cut===fixture.messages.length-1)throw new Error('Invalid source boundary');
  const source=new Map(fixture.messages.slice(0,cut+1).map(message=>[message.id,message]));
  const claimIds=new Set(fixture.requiredClaims.map(claim=>claim.id));
  if(!claimIds.size||claimIds.size!==fixture.requiredClaims.length||!fixture.referenceSummary.trim())throw new Error('Missing or duplicate oracle');
  for(const claim of fixture.requiredClaims){
   claims++;if(!claim.evidence.length)throw new Error('Claim without evidence');
   for(const evidence of claim.evidence)if(!evidence.quote||!source.get(evidence.messageId)?.text.includes(evidence.quote))throw new Error('Evidence quote outside selected prefix');
  }
  if(!fixture.rejectedControls.length)throw new Error('Missing negative control');
  for(const control of fixture.rejectedControls){controls++;if(!control.summary.trim()||control.summary===fixture.referenceSummary||!control.violatedClaimIds.length||control.violatedClaimIds.some(id=>!claimIds.has(id)))throw new Error('Invalid negative control');}
  if(!fixture.qualification.humanReviewRequired||fixture.qualification.unsupportedNewFactsAllowed!==0)throw new Error('Qualification weakened');
 }
 return {fixtures:seen.size,claims,negativeControls:controls,modelRuns:0,modelQuality:'not evaluated'};
}
export function verifyCorpusGuards(){
 const missing=structuredClone(corpus);missing.fixtures[0]!.requiredClaims[0]!.evidence[0]!.quote='NOT IN THE SOURCE';
 const tail=structuredClone(corpus);tail.fixtures[0]!.requiredClaims[0]!.evidence[0]!.messageId=tail.fixtures[0]!.messages.at(-1)!.id;
 for(const invalid of [missing,tail]){let rejected=false;try{validateCorpus(invalid);}catch{rejected=true;}if(!rejected)throw new Error('Invalid evidence was accepted');}
 return validateCorpus();
}
