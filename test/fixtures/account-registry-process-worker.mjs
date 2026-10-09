import { AccountDeviceRegistry } from '../../src/core/account-device-registry.ts';
import { DeviceRegistryStore } from '../../src/core/device-registry.ts';

// An actual independent process and registry instance, not a mocked singleton.
const [stateDir, operation, payload] = process.argv.slice(2);
const accounts = new AccountDeviceRegistry(stateDir, new DeviceRegistryStore(stateDir));
const data = JSON.parse(payload);
try {
  const result = operation === 'resolve'
    ? await accounts.resolveOrCreateAccount(data)
    : operation === 'bind'
      ? await accounts.bindDevice(data.accountId, data.deviceId)
      : operation === 'disable'
        ? await accounts.disableAccount(data.accountId, data.reason)
        : (() => { throw new Error('unknown test operation'); })();
  process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? 'UNEXPECTED', message: error?.message ?? String(error) }) + '\n');
}
