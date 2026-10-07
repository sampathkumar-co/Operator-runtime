import fs from 'node:fs/promises';
import path from 'node:path';
import { certifyR7EnterpriseAcceptanceCampaign, type R7EnterpriseAcceptanceCampaign } from '../src/core/r7-enterprise-acceptance.ts';

const inputPath=process.argv[2];
if(!inputPath){
  process.stderr.write('usage: node --experimental-strip-types scripts/evaluate-r7-enterprise-acceptance.ts <campaign.json>\n');
  process.exit(2);
}
const campaign=JSON.parse(await fs.readFile(path.resolve(inputPath),'utf8')) as R7EnterpriseAcceptanceCampaign;
const report=certifyR7EnterpriseAcceptanceCampaign(campaign);
const outDir=path.resolve('artifacts','r7-enterprise-acceptance');
await fs.mkdir(outDir,{recursive:true});
const outPath=path.join(outDir,'report.json');
await fs.writeFile(outPath,JSON.stringify(report,null,2)+'\n','utf8');
process.stdout.write(JSON.stringify({status:report.status,sourceSha:report.sourceSha,campaignId:report.campaignId,mutationExplanationCoverageRate:report.mutationExplanationCoverageRate,policyReplayActionCount:report.policyReplayActionCount,privateDeploymentPassed:report.privateDeploymentPassed,auditAcceptancePassed:report.auditAcceptancePassed,reasons:report.reasons,reportDigest:report.reportDigest,output:outPath})+'\n');
process.exitCode=report.status==='CERTIFIED'?0:1;
