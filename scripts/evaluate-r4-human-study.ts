import fs from 'node:fs/promises';
import path from 'node:path';
import { certifyR4HumanStudy, type R4HumanStudySession, type R4HumanStudyStandard } from '../src/core/r4-human-study.ts';

interface StudyFile {
  sourceSha: string;
  sessions: R4HumanStudySession[];
  standard?: Partial<R4HumanStudyStandard>;
}

const inputPath=process.argv[2];
if(!inputPath){
  process.stderr.write('usage: npm run evaluate:r4:human-study -- <study.json>\n');
  process.exit(2);
}
const absolute=path.resolve(inputPath);
const parsed=JSON.parse(await fs.readFile(absolute,'utf8')) as StudyFile;
const report=certifyR4HumanStudy(parsed);
const outDir=path.resolve('artifacts','r4-human-study');
await fs.mkdir(outDir,{recursive:true});
const outPath=path.join(outDir,'report.json');
await fs.writeFile(outPath,JSON.stringify(report,null,2)+'\n','utf8');
process.stdout.write(JSON.stringify({
  status:report.status,
  sourceSha:report.sourceSha,
  eligibleParticipantCount:report.eligibleParticipantCount,
  completionRate:report.completionRate,
  assistanceFreeCompletionRate:report.assistanceFreeCompletionRate,
  approvalComprehensionRate:report.approvalComprehensionRate,
  recoveryComprehensionRate:report.recoveryComprehensionRate,
  proofInspectionRate:report.proofInspectionRate,
  medianMinutesToVerifiedTask:report.medianMinutesToVerifiedTask,
  p90MinutesToVerifiedTask:report.p90MinutesToVerifiedTask,
  reasons:report.reasons,
  reportDigest:report.reportDigest,
  output:outPath
})+'\n');
process.exitCode=report.status==='CERTIFIED'?0:1;
