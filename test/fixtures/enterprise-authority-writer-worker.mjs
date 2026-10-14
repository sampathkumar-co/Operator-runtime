import { EnterpriseAuthorityLeaseStore } from '../../src/core/enterprise-authority-lease.ts';

const [root, prefix, countText] = process.argv.slice(2);
const count = Number(countText);
if (!root || !prefix || !Number.isSafeInteger(count) || count < 1 || count > 100) {
  throw new Error('Expected disposable shared root, trusted label, and bounded writes');
}
const store = new EnterpriseAuthorityLeaseStore(root);
for (let i = 0; i < count; i++) {
  await store.issue({
    principalId: `${prefix}:${i}`, purpose: 'synthetic process collision', authorityRevision: 11,
    ttlMs: 60_000,
    grant: { capabilities: ['files.read'], resourcePrefixes: ['project:verified'], maxRisk: 'read' }
  });
}
process.stdout.write('COMPLETE:' + prefix + ':' + count + '\n');
