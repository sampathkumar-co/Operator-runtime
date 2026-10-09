import { EmbeddedControlPlaneStore } from '../../src/core/control-plane-store.ts';
import { RemoteAuthorityFenceStore } from '../../src/core/remote-authority-fence.ts';

// Intentionally separate OS process, and the parent supplies a valid bearer.
// Read-only verification can work across hosts, but no owner-side mutation can.
const [dir, leaseText] = process.argv.slice(2);
const lease = JSON.parse(leaseText);
const provider = new RemoteAuthorityFenceStore(new EmbeddedControlPlaneStore(dir), {
  authorize: async () => {},
  authorizeMutation: async () => {}
});
const check = async (work) => {
  try { await work(); return 'ACCEPTED'; }
  catch (error) { return String(error?.code ?? error?.message ?? error); }
};
const verified = await check(() => provider.assertCurrent(lease));
const heartbeat = await check(() => provider.heartbeat(lease));
const release = await check(() => provider.release(lease));
const commit = await check(() => provider.commitProtected(lease, {
  namespace: 'provider-effects', key: 'stolen-token-effect',
  expectedGeneration: null, value: { disallowed: true }
}));
process.stdout.write(JSON.stringify({ verified, heartbeat, release, commit }) + '\n');
