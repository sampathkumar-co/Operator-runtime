import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const srcDir=join(here,'..','src');

function sourceFiles():Array<{path:string;content:string}>{
  return readdirSync(srcDir,{withFileTypes:true})
    .filter(entry=>entry.isFile()&&entry.name.endsWith('.ts'))
    .map(entry=>{
      const path=join(srcDir,entry.name);
      return{path,content:readFileSync(path,'utf8')};
    });
}

test('standalone core has no direct production-runtime imports',()=>{
  const forbidden=[
    /from\s+['"][^'"]*src\/core\//i,
    /from\s+['"][^'"]*task-orchestrator/i,
    /from\s+['"][^'"]*agent-kernel/i,
    /from\s+['"][^'"]*world-model/i,
    /from\s+['"][^'"]*perception-graph/i,
    /from\s+['"][^'"]*procedure-memory/i,
    /from\s+['"][^'"]*execution-optimizer/i
  ];
  for(const file of sourceFiles()){
    for(const pattern of forbidden){
      assert.equal(pattern.test(file.content),false,file.path+' violates standalone import boundary: '+pattern);
    }
  }
});

test('standalone core performs no ambient secret, network, filesystem, or subprocess access',()=>{
  const forbidden=[
    /process\.env\b/,
    /node:child_process/,
    /node:fs(?:\/|['"])/,
    /node:net(?:\/|['"])/,
    /node:http(?:s)?(?:\/|['"])/,
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /WebSocket\s*\(/
  ];
  for(const file of sourceFiles()){
    for(const pattern of forbidden){
      assert.equal(pattern.test(file.content),false,file.path+' introduces an ambient side effect: '+pattern);
    }
  }
});

test('standalone source contains no known benchmark-task-specific strategy names',()=>{
  const taskSpecific=[
    'click-menu',
    'drag-items',
    'generate-number',
    'tic-tac-toe'
  ];
  for(const file of sourceFiles()){
    const lower=file.content.toLowerCase();
    for(const name of taskSpecific){
      assert.equal(lower.includes(name),false,file.path+' contains benchmark-task-specific identifier '+name);
    }
  }
});

test('source modules cannot silently gain benchmark runner or environment dependencies',()=>{
  const forbidden=[
    /browsergym/i,
    /miniwob/i,
    /webarena/i,
    /workarena/i,
    /osworld/i,
    /terminal-bench/i,
    /theagentcompany/i
  ];
  for(const file of sourceFiles()){
    for(const pattern of forbidden){
      assert.equal(pattern.test(file.content),false,file.path+' contains benchmark-environment coupling: '+pattern);
    }
  }
});
