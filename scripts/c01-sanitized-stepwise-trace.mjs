import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateWave0Record } from './wave0-evaluation.mjs';
import { requireDenseEvaluationArray, requireInertEvaluationObject } from './c01-inert-evaluation-input.mjs';

const SHA=/^[0-9a-f]{40}$/;
const DIGEST=/^[0-9a-f]{64}$/;
const ID=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const LANES=new Set(['A','B','C']);
const PHASES=new Set(['OBSERVE','AUTHORIZE','DISPATCH','VERIFY','RECONCILE','SETTLE']);
const RESULTS=new Set(['PASS','FAIL','BLOCKED','UNKNOWN']);
const SIDE_EFFECTS=new Set(['none','known','uncertain']);
const STAGES=new Set(['none','model','schema','grounding','action','policy','transport','verifier','timing','uncertain_side_effect','unattributed']);
const PROVIDERS=new Set(['model','browser','desktop','filesystem','git','process','docker','postgres','control-plane','other']);
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function deny(message){throw new Error('C01_TRACE_INVALID: '+message)}
function count(x,max){return Number.isSafeInteger(x)&&x>=0&&x<=max;}
function textId(x){return typeof x==='string'&&ID.test(x);}
function recordStep(value,index){
 if(!value||typeof value!=='object'||Array.isArray(value)||
    !count(value.sequence,1000)||value.sequence!==index+1||
    !PHASES.has(value.phase)||!RESULTS.has(value.result)||
    !SIDE_EFFECTS.has(value.sideEffectState)||!STAGES.has(value.failureStage)||
    !PROVIDERS.has(value.providerClass)||
    typeof value.durationMs!=='number'||!Number.isFinite(value.durationMs)||
    value.durationMs<0||value.durationMs>120000||
    typeof value.evidenceDigest!=='string'||!DIGEST.test(value.evidenceDigest)||
    !count(value.actionOrdinal,1000)){
   deny('Each step must have exact sequence, bounded categorical fields and an evidence SHA; raw user content is forbidden.');
 }
 if(value.result==='PASS'&&value.failureStage!=='none')deny('A successful step cannot declare a failure stage.');
 if(value.result!=='PASS'&&value.failureStage==='none')deny('A nonpassing step must carry a failure stage.');
 return {
   sequence:value.sequence,phase:value.phase,providerClass:value.providerClass,
   actionOrdinal:value.actionOrdinal,result:value.result,
   sideEffectState:value.sideEffectState,failureStage:value.failureStage,
   evidenceDigest:value.evidenceDigest,durationMs:value.durationMs
 };
}
/**
 * Produces an immutable, allowlisted stepwise JSONL record and independent
 * run-level scorer digest. Raw arguments/outputs, URLs, file paths, prompts,
 * observations, cookies, device IDs, original receipts and notes are NEVER
 * copied. No data from unknown object keys is permitted into the output.
 *
 * Even a valid run remains a source-owned, not independently authenticated,
 * evaluation report. It cannot establish physical release acceptance.
 */
export function createSanitizedEvaluationTrace(input) {
 requireInertEvaluationObject(input, deny, 'step trace input');
 requireDenseEvaluationArray(input.steps, 1, 1000, deny, 'step receipts');
 for (const step of input.steps) requireInertEvaluationObject(step, deny, 'step receipt');
 requireInertEvaluationObject(input.record, deny, 'scorer record');
 if(!input||typeof input!=='object'||typeof input.sourceCommit!=='string'||!SHA.test(input.sourceCommit)||
    !textId(input.runId)||typeof input.suiteDigest!=='string'||!DIGEST.test(input.suiteDigest)||
    !Array.isArray(input.steps)||input.steps.length<1||input.steps.length>1000||
    !input.record||typeof input.record!=='object'){
   deny('Pinned source, suite, run identity, standard evaluation record and bounded steps required.');
 }
 const run=validateWave0Record(input.record,input.sourceCommit);
 if(run.id!==input.runId||!LANES.has(run.lane))deny('Step trace run identity or lane differs from scorer record.');
 const steps=input.steps.map(recordStep);
 // Uncertain effect persists across any number of observations. Only an
 // explicit positive reconciliation step can clear it before new dispatch.
 const unresolvedUncertain=new Set();
 for(const step of steps){
   if(unresolvedUncertain.size>0&&step.phase==='DISPATCH'){
     deny('Uncertain prior side effect cannot be silently followed by another dispatch.');
   }
   if(step.sideEffectState==='uncertain') unresolvedUncertain.add(step.actionOrdinal);
   // Reconciliation evidence is scoped to the same numeric action identity.
   // A successful read or an unrelated reconciliation must never clear
   // uncertainty about an earlier side effect, and "none" is not proof.
   if(step.phase==='RECONCILE'&&step.result==='PASS'&&step.sideEffectState==='known'){
     unresolvedUncertain.delete(step.actionOrdinal);
   }
 }
 // A single Lane C arm is NOT a paired cohort. Keep only the exact
 // run-level digest here; the separate campaign reporter authenticates pairing.
 const scorerRecordDigest=hash(JSON.stringify(run));
 const header={
   kind:'header',version:1,sourceCommit:input.sourceCommit,
   suiteDigest:input.suiteDigest,
   runIdDigest:hash(input.runId),
   lane:run.lane,arm:run.arm,
   scenarioIdDigest:hash(run.scenarioId),
   runnerDigest:run.runnerDigest,
   environmentDigest:run.environmentDigest,
   modelConfigDigest:run.modelConfigDigest,
   ...(run.lane==='C'?{promptDigest:run.promptDigest,budgetDigest:run.budgetDigest}:{}),
   independentOracleDigest:run.independentOracleDigest
 };
 const lines=[JSON.stringify(header)];
 for(const step of steps)lines.push(JSON.stringify({kind:'step',...step}));
 const stepDigest=hash(lines.join('\n')+'\n');
 const result={
   kind:'scorer',verifiedSuccess:run.verifiedSuccess,
   claimedSuccess:run.claimedSuccess,
   failureStage:run.failureStage,
   resultEvidenceDigest:run.resultEvidenceDigest,
   scorerRecordDigest,
   campaignCoverage:'PARTIAL_UNVERIFIED',
   stepDigest,
   physicalAcceptance:'NOT_VERIFIED',
   releaseAuthorization:'NOT_GRANTED'
 };
 lines.push(JSON.stringify(result));
 const data=lines.join('\n')+'\n';
 if(Buffer.byteLength(data,'utf8')>512*1024)deny('Trace exceeds the allowed byte size.');
 return {bytes:data,sha256:hash(data),stepCount:steps.length,runIdDigest:hash(input.runId),
   releaseAuthorization:'NOT_GRANTED'};
}

/**
 * No overwrite, append, truncation, retry, remote uploads, or silent mutation
 * of a pre-existing run. Export directory is a caller-authorized local root.
 * This writes a separate evidence artifact, not an original task receipt.
 */
export async function persistSanitizedEvaluationTrace({dir,...input}) {
 if(typeof dir!=='string'||!path.isAbsolute(dir))deny('Absolute owner-approved export directory required.');
 const trace=createSanitizedEvaluationTrace(input);
 await fs.mkdir(dir,{recursive:true,mode:0o700});
 const stat=await fs.lstat(dir);
 if(!stat.isDirectory()||stat.isSymbolicLink())deny('Export directory must be real and not a symlink.');
 const name='c01-'+trace.runIdDigest.slice(0,32)+'-'+input.suiteDigest.slice(0,16)+'.jsonl';
 const destination=path.join(path.resolve(dir),name);
 const handle=await fs.open(destination,'wx',0o600);
 try{
   await handle.writeFile(trace.bytes,{encoding:'utf8'});
   await handle.sync();
 }catch(error){
   // A partly written file is treated as evidence corruption. Leave it in
   // place as a tombstone so the same identity cannot be replayed silently.
   throw error;
 }finally{await handle.close()}
 return {filename:name,sha256:trace.sha256,stepCount:trace.stepCount,
   physicalAcceptance:'NOT_VERIFIED',releaseAuthorization:'NOT_GRANTED'};
}
