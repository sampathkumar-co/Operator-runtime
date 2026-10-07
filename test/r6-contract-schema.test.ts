import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { normalizeAgentGatewayProposal } from '../src/core/agent-gateway-contract.ts';
import { R6_CONTRACT_SCHEMAS } from '../src/core/r6-contract-schemas.ts';

test('generated R6 JSON schemas are deterministic and checked in without drift',async()=>{
  for(const [name,schema] of Object.entries(R6_CONTRACT_SCHEMAS)){
    const actual=await fs.readFile(path.join(process.cwd(),'schemas','r6',name+'.schema.json'),'utf8');
    assert.equal(actual,JSON.stringify(schema,null,2)+'\n',name);
  }
});

test('TypeScript gateway digest matches Python SDK fixture',()=>{
  const proposal=normalizeAgentGatewayProposal({
    schemaVersion:1,
    transport:'local-sdk',
    principalId:'agent:python',
    executionContext:{schemaVersion:1,actionId:'python-read'},
    action:{id:'python-read',capability:'file.read',risk:'read',input:{path:'/tmp/example'},provenance:{kind:'chatgpt'}},
    adapterVersion:'1.0.0',
    proposedAt:'2026-10-07T00:00:00.000Z'
  });
  assert.equal(proposal.digest,'4ab82263f99a2eab12b56f436a613fe3d9569fc5cb3d65f00ed62e54bcbebb67');
});
