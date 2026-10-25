import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FilesystemProvider } from '../src/capabilities/filesystem.ts';
import { ProjectInspectProvider } from '../src/capabilities/project.ts';
import { ProjectCommandProvider } from '../src/capabilities/project-command.ts';
import { GitProvider } from '../src/capabilities/git.ts';

const hash=(data:string)=>crypto.createHash('sha256').update(data).digest('hex');
const provenance={kind:'runtime' as const};

test('C06 mixed workflow: project inspect, scoped SHA edit, trusted test, Git diff, independent bytes verification',async t=>{
  const project=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-mixed-workflow-'));
  const authority=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-command-authority-'));
  t.after(async()=>{
    await fs.rm(project,{recursive:true,force:true});
    await fs.rm(authority,{recursive:true,force:true});
  });
  const source=path.join(project,'src','value.txt');
  const unrelated=path.join(project,'src','unrelated.txt');
  await fs.mkdir(path.dirname(source),{recursive:true});
  await fs.writeFile(source,'version=old\n');
  await fs.writeFile(unrelated,'do not change\n');
  await fs.writeFile(path.join(project,'package.json'),JSON.stringify({name:'mecord-mixed-fixture',version:'1.0.0'}));
  const git=(args:string[])=>execFileSync('git',args,{cwd:project,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git(['init','-q']);
  git(['add','--','src/value.txt','src/unrelated.txt','package.json']);
  git(['-c','user.name=Mecord CI','-c','user.email=mecord@example.invalid','commit','-q','-m','initial fixture']);
  const registry=path.join(authority,'project-commands.json');
  const verifierCode=[
    'const fs=require("node:fs")',
    'const value=fs.readFileSync("src/value.txt","utf8")',
    'const other=fs.readFileSync("src/unrelated.txt","utf8")',
    'if(value!=="version=new\\n"||other!=="do not change\\n")process.exit(4)',
    'process.stdout.write("VERIFIED_FIXTURE")'
  ].join(';');
  await fs.writeFile(registry,JSON.stringify({version:1,projects:[{root:project,commands:[{
    id:'verify-fixture',kind:'test',title:'Verify fixture output',
    executable:'node',args:['-e',verifierCode],cwd:'.',risk:'read',timeoutMs:15000
  }]}]}));
  const inspector=new ProjectInspectProvider({allowedRoots:[project]});
  const filesystem=new FilesystemProvider({allowedRoots:[project]});
  const commands=new ProjectCommandProvider({allowedRoots:[project],allowedExecutables:['node'],registryPath:registry});
  const gitProvider=new GitProvider({allowedRoots:[project]});

  const inspected=await inspector.execute({id:'inspect',capability:'project.inspect',risk:'read',
    input:{path:project},provenance});
  assert.equal(inspected.ok,true);
  assert.ok((inspected.output as any).buildSystems.includes('node'));

  const before=await filesystem.execute({id:'observe',capability:'file.read',risk:'read',
    input:{path:source},provenance});
  assert.equal(before.ok,true);
  const firstSha=(before.output as any).sha256 as string;
  assert.equal(firstSha,hash('version=old\n'));

  const write=await filesystem.execute({id:'replace',capability:'file.replace',risk:'write',
    input:{path:source,content:'version=new\n',expectedSha256:firstSha},provenance});
  assert.equal(write.ok,true,write.error?.message);
  assert.equal((write.output as any).afterSha256,hash('version=new\n'));

  const stale=await filesystem.execute({id:'stale-replace',capability:'file.replace',risk:'write',
    input:{path:source,content:'unwanted',expectedSha256:firstSha},provenance});
  assert.equal(stale.ok,false);
  assert.equal(stale.error?.code,'PRECONDITION_FAILED');

  const tested=await commands.execute({id:'trusted-test',capability:'project.command.run',risk:'read',
    input:{path:project,commandId:'verify-fixture',expectedRisk:'read'},provenance});
  assert.equal(tested.ok,true,tested.error?.message);
  assert.equal((tested.output as any).execution.stdout,'VERIFIED_FIXTURE');
  assert.equal((tested.output as any).validation.passed,true);

  const diff=await gitProvider.execute({id:'diff',capability:'git.diff',risk:'read',
    input:{cwd:project,paths:['src/value.txt']},provenance});
  assert.equal(diff.ok,true,diff.error?.message);
  assert.match(JSON.stringify(diff.output),/version=new/);
  assert.doesNotMatch(JSON.stringify(diff.output),/do not change/);

  const observed=await filesystem.execute({id:'readback',capability:'file.read',risk:'read',
    input:{path:source},provenance});
  assert.equal(observed.ok,true);
  assert.equal((observed.output as any).sha256,hash('version=new\n'));
  assert.equal(await fs.readFile(unrelated,'utf8'),'do not change\n');
});
