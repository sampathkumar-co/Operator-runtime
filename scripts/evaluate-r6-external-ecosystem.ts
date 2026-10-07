import fs from 'node:fs/promises';
import path from 'node:path';
import { certifyR6ExternalEcosystemCampaign, type R6ExternalEcosystemCampaign } from '../src/core/r6-external-ecosystem-campaign.ts';

const inputPath=process.argv[2];
if(!inputPath){
  process.stderr.write('usage: node --experimental-strip-types scripts/evaluate-r6-external-ecosystem.ts <campaign.json>\n');
  process.exit(2);
}
const campaign=JSON.parse(await fs.readFile(path.resolve(inputPath),'utf8')) as R6ExternalEcosystemCampaign;
const report=certifyR6ExternalEcosystemCampaign(campaign);
const outDir=path.resolve('artifacts','r6-external-ecosystem');
await fs.mkdir(outDir,{recursive:true});
const outPath=path.join(outDir,'report.json');
await fs.writeFile(outPath,JSON.stringify(report,null,2)+'\n','utf8');
process.stdout.write(JSON.stringify({status:report.status,sourceSha:report.sourceSha,campaignId:report.campaignId,independentIntegrationCount:report.independentIntegrationCount,distinctAgentEcosystems:report.distinctAgentEcosystems,distinctAdapters:report.distinctAdapters,allTrustSemanticsIdentical:report.allTrustSemanticsIdentical,publicPublisherLifecyclePassed:report.publicPublisherLifecyclePassed,reasons:report.reasons,reportDigest:report.reportDigest,output:outPath})+'\n');
process.exitCode=report.status==='CERTIFIED'?0:1;
