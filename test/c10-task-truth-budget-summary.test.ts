import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderControlCenter } from '../apps/local-agent/src/control-center.ts';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/control-center/src');

test('C10 task details separate goal verification and pre-call model reservations from dispatch', async () => {
  const script = await fs.readFile(path.join(source,'app.js'),'utf8');
  const expected = ['Goal: ', 'Independent verification: ', 'Success conditions: ',
    'Latest action: ', 'Model calls reserved', 'Tokens reserved',
    'Cost ceiling reserved', 'Budget values are pre-call reservations',
    'An earlier side effect remains uncertain'];
  for(const label of expected) assert.ok(script.includes(label),label);
  assert.ok(script.includes('wrap.append(actions,taskProgressSummary(task,projection),'),
    'Task summary must be wired into real selected task UI');
  assert.equal(script.includes('innerHTML'), false, 'Task objective must never be interpolated as unescaped HTML');
});

test('C10 generated Control Center exactly matches maintained source files', async () => {
  const [shell,style,script] = await Promise.all(['shell.html','styles.css','app.js']
    .map(file=>fs.readFile(path.join(source,file),'utf8')));
  const norm = (value:string)=>value.replace(/\r\n?/g,'\n');
  const expected=norm(shell)
    .replace('__MECORD_STYLE__',norm(style).trim())
    .replace('__MECORD_SCRIPT__',norm(script).trim())
    .replaceAll('__MECORD_NONCE__','safe_nonce');
  const rendered=renderControlCenter('safe_nonce');
  assert.equal(rendered,expected);
  assert.equal(rendered.includes('Cost ceiling reserved (µ)'),true);
});
