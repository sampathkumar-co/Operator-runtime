import fs from 'node:fs/promises';
import path from 'node:path';
import { certifyR8IndependentProofCampaign, type R8IndependentProofCampaign } from '../src/core/r8-independent-proof-campaign.ts';

const inputPath=process.argv[2];
if(!inputPath){
  process.stderr.write('usage: node --experimental-strip-types scripts/evaluate-r8-independent-proof.ts <campaign.json>\n');
  process.exit(2);
}
const campaign=JSON.parse(await fs.readFile(path.resolve(inputPath),'utf8')) as R8IndependentProofCampaign;
const report=certifyR8IndependentProofCampaign(campaign);
const outDir=path.resolve('artifacts','r8-independent-proof');
await fs.mkdir(outDir,{recursive:true});
const outPath=path.join(outDir,'report.json');
await fs.writeFile(outPath,JSON.stringify(report,null,2)+'\n','utf8');
process.stdout.write(JSON.stringify({status:report.status,sourceSha:report.sourceSha,campaignId:report.campaignId,caseCount:report.caseCount,mutationClassCount:report.mutationClassCount,independentVerificationRate:report.independentVerificationRate,explicitFidelityRate:report.explicitFidelityRate,externalProofVerificationRate:report.externalProofVerificationRate,tamperRejectionRate:report.tamperRejectionRate,inferencePromotionRejectionRate:report.inferencePromotionRejectionRate,insufficientFidelityDenialCount:report.insufficientFidelityDenialCount,verifiedMutationRate:report.verifiedMutationRate,reasons:report.reasons,reportDigest:report.reportDigest,output:outPath})+'\n');
process.exitCode=report.status==='CERTIFIED'?0:1;
