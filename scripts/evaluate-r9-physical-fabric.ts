import fs from 'node:fs/promises';
import path from 'node:path';
import { certifyR9PhysicalFabricCampaign, type R9PhysicalFabricCampaign } from '../src/core/r9-physical-fabric-campaign.ts';

const inputPath=process.argv[2];
if(!inputPath){
  process.stderr.write('usage: node --experimental-strip-types scripts/evaluate-r9-physical-fabric.ts <campaign.json>\n');
  process.exit(2);
}
const campaign=JSON.parse(await fs.readFile(path.resolve(inputPath),'utf8')) as R9PhysicalFabricCampaign;
const report=certifyR9PhysicalFabricCampaign(campaign);
const outDir=path.resolve('artifacts','r9-physical-fabric');
await fs.mkdir(outDir,{recursive:true});
const outPath=path.join(outDir,'report.json');
await fs.writeFile(outPath,JSON.stringify(report,null,2)+'\n','utf8');
process.stdout.write(JSON.stringify({
  status:report.status,sourceSha:report.sourceSha,campaignId:report.campaignId,
  physicalMachineCount:report.physicalMachineCount,distinctPlatformCount:report.distinctPlatformCount,
  verifiedWorkUnitRate:report.verifiedWorkUnitRate,lineageCoverageRate:report.lineageCoverageRate,
  artifactRecoveryRate:report.artifactRecoveryRate,allRequiredFaultsPassed:report.allRequiredFaultsPassed,
  splitBrainCount:report.splitBrainCount,duplicateExecutionCount:report.duplicateExecutionCount,
  authorityViolationCount:report.authorityViolationCount,evidenceLossCount:report.evidenceLossCount,
  reasons:report.reasons,reportDigest:report.reportDigest,output:outPath
})+'\n');
process.exitCode=report.status==='CERTIFIED'?0:1;
