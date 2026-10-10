import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountDeviceRegistry } from '../src/core/account-device-registry.ts';
import { DeviceRegistryStore } from '../src/core/device-registry.ts';

test('active account authority work requires exact JSON generation and UUID string types', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-account-exact-authority-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const devices = new DeviceRegistryStore(root);
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const deviceId = crypto.randomUUID();
  await devices.registerVerifiedPeer({
    deviceId, deviceName: 'Test Device', createdAt: new Date(0).toISOString(),
    publicKeyPem, fingerprint: crypto.createHash('sha256').update(publicKeyPem).digest('base64url')
  });
  const accounts = new AccountDeviceRegistry(root, devices);
  const account = await accounts.resolveOrCreateAccount({ issuer: 'test', subject: 'owner' });
  const bound = await accounts.bindDevice(account.accountId, deviceId);
  const authority = { accountId: account.accountId, deviceId, generation: bound.authorityGeneration };
  let executed = 0;
  assert.equal(await accounts.withActiveAuthorityLease(authority, async () => { executed++; return 'accepted'; }), 'accepted');
  for (const forged of [
    { ...authority, generation: String(authority.generation) },
    { ...authority, generation: [authority.generation] },
    { ...authority, generation: true },
    { ...authority, accountId: [account.accountId] },
    { ...authority, deviceId: [deviceId] }
  ]) {
    await assert.rejects(
      accounts.withActiveAuthorityLease(forged as any, async () => { executed++; return 'unexpected'; }),
      (error: any) => ['ACCOUNT_AUTHORITY_INVALID','ACCOUNT_ID_INVALID'].includes(error?.code)
    );
  }
  assert.equal(executed, 1);
  await assert.rejects(accounts.ownsDevice([account.accountId] as any, deviceId),
    (error: any) => error?.code === 'ACCOUNT_ID_INVALID');
});
