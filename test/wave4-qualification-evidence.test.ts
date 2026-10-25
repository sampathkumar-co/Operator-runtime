import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  WAVE4_QUALIFICATION_GATES,
  buildWave4QualificationEvidence,
  notRunDeclaration
} from '../scripts/wave4-qualification-evidence.mjs';

const candidateSha = 'a'.repeat(40);
const sha256 = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-wave4-evidence-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function declaration(status = 'NOT_RUN') {
  const value = notRunDeclaration(candidateSha);
  for (const gate of WAVE4_QUALIFICATION_GATES) value.gates[gate].status = status;
  return value;
}

async function attach(root: string, input: ReturnType<typeof declaration>, gate: string, status = 'PASS') {
  const relative = gate + '.json';
  const bytes = JSON.stringify({ candidateSha, gate, result: status });
  await fs.writeFile(path.join(root, relative), bytes);
  input.gates[gate] = {
    status,
    summary: status === 'PASS' ? 'Source-matched qualification passed.' : 'Qualification failed safely.',
    artifacts: [{ candidateSha, path: relative, sha256: sha256(bytes) }]
  };
}

test('source-only execution reports every gate NOT_RUN deterministically and never authorizes publication', async t => {
  const root = await fixture(t);
  const input = notRunDeclaration(candidateSha);
  const left = await buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input });
  const right = await buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input });
  assert.deepEqual(left, right);
  assert.equal(left.qualificationStatus, 'INCOMPLETE');
  assert.deepEqual(left.counts, { pass: 0, fail: 0, notRun: 9 });
  assert.equal(left.publicationAllowed, false);
  assert.match(left.manifestSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(left.gates.map(gate => gate.gate), WAVE4_QUALIFICATION_GATES);
});

test('nine self-declared PASS artifacts remain explicitly unverified even when digest-bound', async t => {
  const root = await fixture(t);
  const input = declaration();
  for (const gate of WAVE4_QUALIFICATION_GATES) await attach(root, input, gate);
  const report = await buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input });
  assert.equal(report.qualificationStatus, 'ALL_GATES_DECLARED_PASS_UNVERIFIED');
  assert.deepEqual(report.counts, { pass: 9, fail: 0, notRun: 0 });
  assert.ok(report.gates.every(gate => gate.evidenceSha256 && gate.artifacts[0]?.sizeBytes > 0));
  assert.equal(report.publicationAllowed, false);
});

test('a recorded failure dominates NOT_RUN and PASS without masquerading as qualification', async t => {
  const root = await fixture(t);
  const input = declaration();
  await attach(root, input, WAVE4_QUALIFICATION_GATES[0], 'PASS');
  await attach(root, input, WAVE4_QUALIFICATION_GATES[1], 'FAIL');
  const report = await buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input });
  assert.equal(report.qualificationStatus, 'FAILED');
  assert.deepEqual(report.counts, { pass: 1, fail: 1, notRun: 7 });
});

test('wrong source, changed bytes and type-confused digests fail closed', async t => {
  const root = await fixture(t);
  const input = declaration();
  const gate = WAVE4_QUALIFICATION_GATES[0];
  await attach(root, input, gate);
  input.gates[gate].artifacts[0].candidateSha = 'b'.repeat(40);
  await assert.rejects(buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input }), /source identity/);
  input.gates[gate].artifacts[0].candidateSha = candidateSha;
  await fs.appendFile(path.join(root, gate + '.json'), 'tampered');
  await assert.rejects(buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input }), /digest mismatch/);
  input.gates[gate].artifacts[0].sha256 = [sha256('fake')] as unknown as string;
  await assert.rejects(buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input }), /path or SHA-256/);
});

test('gate roster, statuses and evidence requirements cannot be weakened or extended', async t => {
  const root = await fixture(t);
  const input: any = declaration();
  delete input.gates[WAVE4_QUALIFICATION_GATES[0]];
  await assert.rejects(buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input }), /roster shape/);
  input.gates[WAVE4_QUALIFICATION_GATES[0]] = { status: 'SKIPPED', summary: 'skip', artifacts: [] };
  await assert.rejects(buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input }), /status, summary or artifacts/);
  input.gates[WAVE4_QUALIFICATION_GATES[0]].status = 'PASS';
  await assert.rejects(buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input }), /requires digest-bound evidence/);
  input.gates[WAVE4_QUALIFICATION_GATES[0]].status = 'NOT_RUN';
  input.gates.forged_release_gate = { status: 'PASS', summary: 'fake', artifacts: [] };
  await assert.rejects(buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input }), /roster shape/);
});

test('path traversal, symlinks and cross-gate artifact reuse are rejected', async t => {
  const root = await fixture(t);
  const outside = path.join(path.dirname(root), 'outside-wave4-evidence.json');
  await fs.writeFile(outside, 'outside');
  t.after(async () => fs.rm(outside, { force: true }));
  const input: any = declaration();
  const gate = WAVE4_QUALIFICATION_GATES[0];
  input.gates[gate] = {
    status: 'PASS', summary: 'Traversal attempt.',
    artifacts: [{ candidateSha, path: '../outside-wave4-evidence.json', sha256: sha256('outside') }]
  };
  await assert.rejects(buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input }), /path or SHA-256/);

  if (process.platform !== 'win32') {
    await fs.symlink(outside, path.join(root, 'linked.json'));
    input.gates[gate].artifacts[0] = { candidateSha, path: 'linked.json', sha256: sha256('outside') };
    await assert.rejects(buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input }), /bounded regular file/);
  }

  await attach(root, input, gate);
  const other = WAVE4_QUALIFICATION_GATES[1];
  input.gates[other] = { ...input.gates[gate], summary: 'Reused evidence.' };
  await assert.rejects(buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input }), /globally unique paths/);
});

test('manifest digest changes with status or artifact content while identical input stays stable', async t => {
  const root = await fixture(t);
  const input = declaration();
  await attach(root, input, WAVE4_QUALIFICATION_GATES[0], 'PASS');
  const first = await buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input });
  const same = await buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input });
  assert.equal(first.manifestSha256, same.manifestSha256);
  input.gates[WAVE4_QUALIFICATION_GATES[0]].status = 'FAIL';
  input.gates[WAVE4_QUALIFICATION_GATES[0]].summary = 'Qualification failed safely.';
  const changed = await buildWave4QualificationEvidence({ candidateSha, evidenceRoot: root, declaration: input });
  assert.notEqual(first.manifestSha256, changed.manifestSha256);
});
