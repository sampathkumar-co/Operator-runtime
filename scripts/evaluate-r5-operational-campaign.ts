import fs from 'node:fs/promises';
import path from 'node:path';
import { certifyR5OperationalCampaign, type R5OperationalCampaign } from '../src/core/r5-operational-campaign.ts';

const inputPath=process.argv[2];
if(!inputPath){
  process.stderr.write('usage: node --experimental-strip-types scripts/evaluate-r5-operational-campaign.ts <campaign.json>\n');
  process.exit(2);
}
const campaign=JSON.parse(await fs.readFile(path.resolve(inputPath),'utf8')) as R5OperationalCampaign;
const report=certifyR5OperationalCampaign(campaign);
const outDir=path.resolve('artifacts','r5-operational-campaign');
await fs.mkdir(outDir,{recursive:true});
const outPath=path.join(outDir,'report.json');
await fs.writeFile(outPath,JSON.stringify(report,null,2)+'\n','utf8');
process.stdout.write(JSON.stringify({status:report.status,sourceSha:report.sourceSha,campaignId:report.campaignId,durationMs:report.durationMs,soak24hPassed:report.soak24hPassed,soak72hPassed:report.soak72hPassed,sloHealthy:report.sloHealthy,allFaultClassesPassed:report.allFaultClassesPassed,reasons:report.reasons,reportDigest:report.reportDigest,output:outPath})+'\n');
process.exitCode=report.status==='CERTIFIED'?0:1;
