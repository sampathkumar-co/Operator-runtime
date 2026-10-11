import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { OperatorPreDispatchAdjudicator } from '../apps/local-agent/src/operator-pre-dispatch-adjudication.ts';

function take(flag: string): string | undefined {
  const i=process.argv.indexOf(flag);
  return i<0 ? undefined : process.argv[i+1];
}
const mode=process.argv[2];
const actionId=take('--action-id');
const stateDir=path.resolve(take('--state-dir')??path.join(os.homedir(),'.operator'));
if (!actionId || (mode!=='inspect' && mode!=='adjudicate')) {
  console.error('Usage: node --experimental-strip-types scripts/operator-pre-dispatch-recovery.ts inspect|adjudicate --action-id <exact ID> [--state-dir <protected state>] [--dpapi-helper <trusted path>] [--case-digest <previously reviewed 64-hex challenge>]');
  process.exitCode=2;
} else {
  try {
    const dirStat=await fs.lstat(stateDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('State root must be a real existing directory.');
    const dpapiExecutable=take('--dpapi-helper');
    const signer=new DeviceIdentityStore(stateDir,dpapiExecutable?{dpapiExecutable:path.resolve(dpapiExecutable)}:{});
    const op=new OperatorPreDispatchAdjudicator(stateDir,{signer});
    if(mode==='inspect') {
      const c=await op.inspect(actionId);
      console.log(JSON.stringify({ status:'REVIEW_REQUIRED', ...c,
        note:'Read-only case. Before adjudication confirm the original process is stopped, this is the original device-owned state and the journal never dispatched. No approval is inferred from prior consumed grants.'
      },null,2));
    } else {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('Operator adjudication requires an interactive local console. Headless MCP/relay calls are prohibited.');
      }
      const expected=take('--case-digest')??(await op.inspect(actionId)).caseDigest;
      console.log('EXACT ACTION',actionId,'EXACT CASE',expected);
      console.log('This irrevocably prevents dispatch of this historical action. It will NOT execute the approved action.');
      const prompt=readline.createInterface({input:process.stdin,output:process.stdout});
      let confirmation='';
      let ownerAttestation='';
      try {
        confirmation=await prompt.question('Type AUTHORIZE-NO-REPLAY:<case-digest> exactly: ');
        ownerAttestation=await prompt.question('Type I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED exactly: ');
      } finally { prompt.close(); }
      const result=await op.adjudicate({actionId,caseDigest:expected,confirmation,ownerAttestation});
      console.log(JSON.stringify({
        ...result, terminalJournalFence:true,
        receiptRecovery:'Requires verified newer runtime to reconcile original relay delivery. This utility never replays the action or alters the relay cursor.'
      },null,2));
    }
  } catch(e) {
    console.error('RECOVERY_REFUSED',e instanceof Error?e.message:String(e));
    process.exitCode=1;
  }
}
