import fs from 'node:fs/promises';
import path from 'node:path';
import { certifyR10EmpiricalOutcomeCampaign, type R10EmpiricalOutcomeCampaign } from '../src/core/r10-empirical-outcome-campaign.ts';

const inputPath=process.argv[2];
if(!inputPath){
  process.stderr.write('usage: node --experimental-strip-types scripts/evaluate-r10-empirical-outcomes.ts <campaign.json>\n');
  process.exit(2);
}
const campaign=JSON.parse(await fs.readFile(path.resolve(inputPath),'utf8')) as R10EmpiricalOutcomeCampaign;
const report=certifyR10EmpiricalOutcomeCampaign(campaign);
const outDir=path.resolve('artifacts','r10-empirical-outcomes');
await fs.mkdir(outDir,{recursive:true});
const outPath=path.join(outDir,'report.json');
await fs.writeFile(outPath,JSON.stringify(report,null,2)+'\n','utf8');
process.stdout.write(JSON.stringify({
  status:report.status,sourceSha:report.sourceSha,campaignId:report.campaignId,
  pairCount:report.pairCount,categoryCount:report.categoryCount,verifierCount:report.verifierCount,
  baselineFirstCount:report.baselineFirstCount,r10FirstCount:report.r10FirstCount,
  interruptionCaseCount:report.interruptionCaseCount,rollbackCaseCount:report.rollbackCaseCount,
  baseline:report.baseline,current:report.current,
  meanBaselineHumanInterventionMinutes:report.meanBaselineHumanInterventionMinutes,
  meanCurrentHumanInterventionMinutes:report.meanCurrentHumanInterventionMinutes,
  engineeringCertificationDigest:report.engineeringCertificationDigest,
  reasons:report.reasons,reportDigest:report.reportDigest,output:outPath
})+'\n');
process.exitCode=report.status==='CERTIFIED'?0:1;
