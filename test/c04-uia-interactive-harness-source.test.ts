import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { strictUiaOperationIdentity, WindowsUiaProvider } from '../src/capabilities/windows-uia.ts';

test('C04-02 owner-session harness binds every operation to its disposable fixture process', () => {
  const source = fs.readFileSync('test/fixtures/windows-uia-contract-app/run-interactive-uia.ps1', 'utf8');
  for (const marker of ['inspect-main', 'focus-name', 'set-name', 'invoke-save', 'inspect-status', 'wrong-process']) assert.match(source, new RegExp(marker));
  assert.match(source, /process_id\s*=\s*\$app\.Id/);
  assert.match(source, /protectedWindowsTouched=\$false/);
  assert.doesNotMatch(source, /Get-Process|EnumWindows|Stop-Process\s+(?!-Id\s+\$app\.Id)/);
});

test('C04-03 native operation identity rejects process, window, automation-id and operation substitution', () => {
  const expected = { operation: 'focus', selector: { process_id: 42, automation_id: 'name-field' } };
  const valid = {
    operation: 'focus', before: { process_id: 42, automation_id: 'name-field', window_id: '0xA' },
    after: { process_id: 42, automation_id: 'name-field', window_id: '0xa' }, postcondition: { verified: true }
  };
  assert.doesNotThrow(() => strictUiaOperationIdentity(valid, expected));
  assert.doesNotThrow(() => strictUiaOperationIdentity({ operation: 'activate_window',
    before: { process_id: 42, window_id: '0xA' }, after: { process_id: 42, window_id: '0xa' } },
  { operation: 'activate_window', selector: { process_id: 42, automation_id: 'main-window' } }));
  for (const value of [
    { ...valid, operation: 'invoke' },
    { ...valid, after: { ...valid.after, process_id: 43 } },
    { ...valid, after: { ...valid.after, window_id: '0xB' } },
    { ...valid, after: { ...valid.after, automation_id: 'other-field' } }
  ]) assert.throws(() => strictUiaOperationIdentity(value, expected), (error: any) => error?.code === 'UIA_OPERATION_IDENTITY_INVALID');
});

test('C04-03 provider treats a native identity switch as uncertain and non-retryable', async () => {
  const client = { close() {}, async call() { return {
    operation: 'focus', before: { process_id: 42, automation_id: 'name-field', window_id: '0xA' },
    after: { process_id: 99, automation_id: 'name-field', window_id: '0xA' }, postcondition: { verified: true }
  }; } };
  const provider = new WindowsUiaProvider({ platform: 'win32', client });
  const outcome = await provider.execute({ id: 'identity-switch', capability: 'app.operate', risk: 'write',
    input: { operation: 'focus', selector: { processId: 42, automationId: 'name-field' } }, provenance: { kind: 'runtime' } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'UIA_OPERATION_IDENTITY_INVALID');
  assert.equal(outcome.error?.sideEffectState, 'uncertain');
  assert.equal(outcome.error?.retryable, false);
});
