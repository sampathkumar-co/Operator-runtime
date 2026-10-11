import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root=path.resolve(import.meta.dirname,'..');
test('production Chrome provider and CDP transport never fake focus or visibility during browser operations',async()=>{
 for(const relative of [
  'src/capabilities/browser-cdp.ts',
  'src/capabilities/browser-cdp-page.ts',
  'src/capabilities/browser-cdp-frames.ts',
  'src/capabilities/browser-cdp-connection.ts'
 ]){
  const code=await fs.readFile(path.join(root,relative),'utf8');
  assert.doesNotMatch(code,/Emulation\.setFocusEmulationEnabled|setFocusEmulationEnabled/,
   relative+' must never emulate focus in ordinary user tabs.');
  assert.doesNotMatch(code,/--disable-renderer-backgrounding|--disable-background-timer-throttling/,
   relative+' must not silently change the browser launch behavior.');
 }
});
test('unsafe emulation remains isolated to an explicitly selected and reversible synthetic test',async()=>{
 const code=await fs.readFile(path.join(root,'scripts/benchmark-pipeline-latency.mjs'),'utf8');
 assert.match(code,/MECORD_BENCH_FOCUS_EMULATION === '1'/);
 assert.match(code,/Emulation\.setFocusEmulationEnabled/);
 assert.match(code,/Synthetic focus emulation failed to restore the exact initial focus and visibility state/);
 assert.match(code,/provider\?\.close\(\)/);
 assert.match(code,/fs\.mkdtemp\(/);
 assert.match(code,/await fs\.rm\(profile,/);
});
