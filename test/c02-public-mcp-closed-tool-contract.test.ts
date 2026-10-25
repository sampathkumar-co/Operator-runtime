import assert from 'node:assert/strict';
import test from 'node:test';
import { PUBLIC_PLUGIN_TOOL_NAMES } from '../src/core/public-plugin-surface.ts';
import { registerPublicTools } from '../apps/mcp-server/src/public-tools.ts';

function fixture(){
  let list: (()=>{tools:Array<{name:string;securitySchemes:unknown}>}) | undefined;
  const registry:Record<string,any>=Object.create(null);
  const server={
    _registeredTools:registry,
    registerTool:(name:string,definition:any)=>{
      registry[name]={...definition,enabled:true};
    },
    toolInputSchemaJson:()=>({type:'object',properties:{}}),
    server:{
      removeRequestHandler:()=>{},
      setRequestHandler:(method:string,handler:any)=>{
        assert.equal(method,'tools/list');
        list=handler;
      }
    }
  };
  registerPublicTools(server as any,async()=>({ok:true}),
    {readScope:'mecord:read',writeScope:'mecord:write'});
  return {registry,list:()=>list!()};
}

test('C02 public MCP exposes precisely nine well-typed OAuth-scoped tool contracts',()=>{
  const {list}=fixture();
  const actual=list().tools;
  assert.equal(actual.length,9);
  assert.deepEqual(actual.map(x=>x.name).sort(),[...PUBLIC_PLUGIN_TOOL_NAMES].sort());
  for(const tool of actual){
    const schemes=tool.securitySchemes as Array<{type:string;scopes:string[]}>;
    assert.equal(schemes.length,1);
    assert.equal(schemes[0]?.type,'oauth2');
    assert.ok(schemes[0]?.scopes.includes('mecord:read'));
    assert.ok(schemes[0]?.scopes.every(scope=>typeof scope==='string'));
  }
});

test('C02 public MCP refuses any unexpected tool, rather than silently widening scope',()=>{
  const {registry,list}=fixture();
  registry['terminal.execute']={
    enabled:true,title:'Injected tool',_meta:{securitySchemes:[{type:'oauth2',scopes:['mecord:read']}]}
  };
  assert.throws(()=>list(),/PUBLIC_TOOL_SURFACE_MISMATCH/);
  delete registry['terminal.execute'];
  registry['file.create'].enabled=false;
  assert.throws(()=>list(),/PUBLIC_TOOL_SURFACE_MISMATCH/);
});

test('C02 public MCP refuses type-confused OAuth scopes even when array-coercible',()=>{
  const {registry,list}=fixture();
  registry['file.read']._meta.securitySchemes=[{type:'oauth2',scopes:[['mecord:read']]}];
  assert.throws(()=>list(),/exact literal strings/);
  registry['file.read']._meta.securitySchemes=[{type:'oauth2',scopes:[{toString:()=> 'mecord:read'}]}];
  assert.throws(()=>list(),/exact literal strings/);
  registry['file.read']._meta.securitySchemes=[{type:'oauth2',scopes:['mecord:read']}];
  assert.equal(list().tools.length,9);
});
