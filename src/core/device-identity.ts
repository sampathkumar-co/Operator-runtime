import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { OperatorError } from './errors.ts';
import { safeChildEnvironment } from './child-environment.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_IDENTITY_BYTES = 256 * 1024;
const MAX_HELPER_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_HELPER_ERROR_BYTES = 4096;
const DPAPI_SCHEME = 'windows-dpapi-current-user' as const;

interface IdentityBase {
  deviceId: string;
  deviceName: string;
  createdAt: string;
  publicKeyPem: string;
}

interface StoredIdentityV1 extends IdentityBase {
  version: 1;
  privateKeyPem: string;
}

interface StoredIdentityV2 extends IdentityBase {
  version: 2;
  privateKeyProtection: {
    scheme: typeof DPAPI_SCHEME;
    keyFormat: 'pkcs8-der';
    ciphertextBase64: string;
  };
}

type StoredIdentity = StoredIdentityV1 | StoredIdentityV2;

export interface DeviceSecretProtector {
  readonly scheme: typeof DPAPI_SCHEME;
  protect(input: Buffer): Promise<Buffer>;
  unprotect(input: Buffer): Promise<Buffer>;
}

export interface PublicDeviceIdentity {
  deviceId: string;
  deviceName: string;
  createdAt: string;
  publicKeyPem: string;
  fingerprint: string;
}

export class DeviceIdentityStore {
  #file: string;
  #platform: NodeJS.Platform;
  #protector?: DeviceSecretProtector;
  #dpapiExecutable?: string;

  constructor(stateDir: string, options: {
    platform?: NodeJS.Platform;
    secretProtector?: DeviceSecretProtector;
    dpapiExecutable?: string;
  } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'device-identity.json');
    this.#platform = options.platform ?? process.platform;
    this.#protector = options.secretProtector;
    this.#dpapiExecutable = options.dpapiExecutable ?? process.env.OPERATOR_WINDOWS_DPAPI_PATH;
    if (this.#protector && this.#protector.scheme !== DPAPI_SCHEME) {
      throw new OperatorError('DEVICE_SECRET_PROTECTOR_INVALID', 'Unsupported device secret protection scheme.');
    }
  }

  async loadOrCreate(deviceName = os.hostname()): Promise<PublicDeviceIdentity> {
    let stored: StoredIdentity;
    try {
      stored = await this.#readAndMigrate();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      stored = await this.#create(deviceName);
    }
    return publicIdentity(stored);
  }

  async sign(payload: Uint8Array): Promise<string> {
    let stored: StoredIdentity;
    try { stored = await this.#readAndMigrate(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new OperatorError('DEVICE_IDENTITY_MISSING', 'Device identity has not been created.');
      }
      throw error;
    }

    if (stored.version === 1) {
      return crypto.sign(null, payload, stored.privateKeyPem).toString('base64url');
    }

    const protector = this.#requireWindowsProtector();
    const ciphertext = decodeCiphertext(stored.privateKeyProtection.ciphertextBase64);
    let privateDer: Buffer | undefined;
    try {
      privateDer = await protector.unprotect(ciphertext);
      if (privateDer.length === 0 || privateDer.length > 64 * 1024) {
        throw new OperatorError('DEVICE_PRIVATE_KEY_INVALID', 'Protected device private key had an invalid size.');
      }
      const key = crypto.createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' });
      return crypto.sign(null, payload, key).toString('base64url');
    } catch (error) {
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('DEVICE_PRIVATE_KEY_UNPROTECT_FAILED', 'Windows could not unlock the device private key for the current user.');
    } finally {
      ciphertext.fill(0);
      privateDer?.fill(0);
    }
  }

  async verify(payload: Uint8Array, signature: string): Promise<boolean> {
    let stored: StoredIdentity;
    try { stored = await this.#readAndMigrate(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new OperatorError('DEVICE_IDENTITY_MISSING', 'Device identity has not been created.');
      }
      throw error;
    }
    return crypto.verify(null, payload, stored.publicKeyPem, Buffer.from(signature, 'base64url'));
  }

  async #create(deviceName: string): Promise<StoredIdentity> {
    await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const base: IdentityBase = {
      deviceId: crypto.randomUUID(),
      deviceName,
      createdAt: new Date().toISOString(),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
    };

    if (this.#platform !== 'win32') {
      const stored: StoredIdentityV1 = {
        version: 1,
        ...base,
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
      };
      await writeExclusiveJson(this.#file, stored);
      return stored;
    }

    const protector = this.#requireWindowsProtector();
    const privateDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
    let protectedBytes: Buffer | undefined;
    try {
      protectedBytes = await protector.protect(privateDer);
      if (protectedBytes.length === 0 || protectedBytes.length > MAX_HELPER_OUTPUT_BYTES) {
        throw new OperatorError('DEVICE_PRIVATE_KEY_PROTECT_FAILED', 'Windows returned an invalid protected device key blob.');
      }
      const stored: StoredIdentityV2 = {
        version: 2,
        ...base,
        privateKeyProtection: {
          scheme: DPAPI_SCHEME,
          keyFormat: 'pkcs8-der',
          ciphertextBase64: protectedBytes.toString('base64')
        }
      };
      await writeExclusiveJson(this.#file, stored);
      return stored;
    } finally {
      privateDer.fill(0);
      protectedBytes?.fill(0);
    }
  }

  async #readAndMigrate(): Promise<StoredIdentity> {
    const raw = await readDurableStateText(this.#file, {
      maxBytes: MAX_IDENTITY_BYTES,
      errorCode: 'DEVICE_IDENTITY_INVALID',
      invalidMessage: 'Device identity file is invalid.'
    });
    let stored: StoredIdentity;
    try { stored = parseStoredIdentity(JSON.parse(raw)); }
    catch (error) {
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('DEVICE_IDENTITY_INVALID', 'Device identity file could not be parsed.');
    }
    if (this.#platform === 'win32' && stored.version === 1) {
      return await this.#migrateWindowsIdentity(stored);
    }
    return stored;
  }

  async #migrateWindowsIdentity(legacy: StoredIdentityV1): Promise<StoredIdentityV2> {
    const protector = this.#requireWindowsProtector();
    let privateDer: Buffer | undefined;
    let protectedBytes: Buffer | undefined;
    try {
      const key = crypto.createPrivateKey(legacy.privateKeyPem);
      privateDer = key.export({ type: 'pkcs8', format: 'der' }) as Buffer;
      protectedBytes = await protector.protect(privateDer);
      if (protectedBytes.length === 0 || protectedBytes.length > MAX_HELPER_OUTPUT_BYTES) {
        throw new OperatorError('DEVICE_PRIVATE_KEY_PROTECT_FAILED', 'Windows returned an invalid protected device key blob during migration.');
      }
      const migrated: StoredIdentityV2 = {
        version: 2,
        deviceId: legacy.deviceId,
        deviceName: legacy.deviceName,
        createdAt: legacy.createdAt,
        publicKeyPem: legacy.publicKeyPem,
        privateKeyProtection: {
          scheme: DPAPI_SCHEME,
          keyFormat: 'pkcs8-der',
          ciphertextBase64: protectedBytes.toString('base64')
        }
      };
      await replaceJsonAtomic(this.#file, migrated);
      return migrated;
    } catch (error) {
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('DEVICE_IDENTITY_MIGRATION_FAILED', 'Legacy Windows device identity could not be migrated to protected storage.');
    } finally {
      privateDer?.fill(0);
      protectedBytes?.fill(0);
    }
  }

  #requireWindowsProtector(): DeviceSecretProtector {
    if (this.#platform !== 'win32') {
      throw new OperatorError('DEVICE_SECRET_PROTECTOR_UNAVAILABLE', 'Windows DPAPI protection is only available on Windows.');
    }
    if (this.#protector) return this.#protector;
    const executable = this.#dpapiExecutable;
    if (!executable || !path.isAbsolute(executable)) {
      throw new OperatorError('WINDOWS_DPAPI_HELPER_REQUIRED', 'Windows device identity protection requires an absolute OPERATOR_WINDOWS_DPAPI_PATH.');
    }
    this.#protector = new WindowsDpapiProtector(executable);
    return this.#protector;
  }
}

export class WindowsDpapiProtector implements DeviceSecretProtector {
  readonly scheme = DPAPI_SCHEME;
  #executable: string;

  constructor(executable: string) {
    if (!path.isAbsolute(executable)) {
      throw new OperatorError('WINDOWS_DPAPI_HELPER_REQUIRED', 'Windows DPAPI helper path must be absolute.');
    }
    this.#executable = executable;
  }

  async protect(input: Buffer): Promise<Buffer> {
    return await runSecretHelper(this.#executable, 'protect', input);
  }

  async unprotect(input: Buffer): Promise<Buffer> {
    return await runSecretHelper(this.#executable, 'unprotect', input);
  }
}

async function runSecretHelper(executable: string, operation: 'protect' | 'unprotect', input: Buffer): Promise<Buffer> {
  if (input.length === 0 || input.length > 1024 * 1024) {
    throw new OperatorError('DEVICE_PRIVATE_KEY_INVALID', 'Device secret helper input had an invalid size.');
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(executable, [operation], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: safeChildEnvironment('windows-native')
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;

    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once('error', () => finishReject(new OperatorError('WINDOWS_DPAPI_HELPER_FAILED', 'Windows DPAPI helper could not be started.')));
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_HELPER_OUTPUT_BYTES) return;
      const slice = chunk.subarray(0, MAX_HELPER_OUTPUT_BYTES - stdoutBytes);
      stdout.push(slice);
      stdoutBytes += slice.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_HELPER_ERROR_BYTES) return;
      const slice = chunk.subarray(0, MAX_HELPER_ERROR_BYTES - stderrBytes);
      stderr.push(slice);
      stderrBytes += slice.length;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, 15_000);
    timer.unref();

    child.once('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (timedOut) {
        reject(new OperatorError('WINDOWS_DPAPI_HELPER_TIMEOUT', 'Windows DPAPI helper timed out.'));
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 512);
        reject(new OperatorError('WINDOWS_DPAPI_HELPER_FAILED', detail ? `Windows DPAPI helper failed: ${detail}` : 'Windows DPAPI helper failed.'));
        return;
      }
      if (stdoutBytes >= MAX_HELPER_OUTPUT_BYTES) {
        reject(new OperatorError('WINDOWS_DPAPI_HELPER_FAILED', 'Windows DPAPI helper output exceeded the allowed size.'));
        return;
      }
      const output = Buffer.concat(stdout);
      if (output.length === 0) {
        output.fill(0);
        reject(new OperatorError('WINDOWS_DPAPI_HELPER_FAILED', 'Windows DPAPI helper returned no data.'));
        return;
      }
      resolve(output);
    });

    child.stdin.once('error', () => {
      if (!settled) finishReject(new OperatorError('WINDOWS_DPAPI_HELPER_FAILED', 'Windows DPAPI helper rejected secret input.'));
    });
    child.stdin.end(input);
  });
}

function parseStoredIdentity(value: unknown): StoredIdentity {
  if (!value || typeof value !== 'object') {
    throw new OperatorError('DEVICE_IDENTITY_INVALID', 'Device identity must be an object.');
  }
  const raw = value as Record<string, unknown>;
  const base = {
    deviceId: boundedString(raw.deviceId, 'deviceId', 128),
    deviceName: boundedString(raw.deviceName, 'deviceName', 512),
    createdAt: boundedString(raw.createdAt, 'createdAt', 128),
    publicKeyPem: boundedString(raw.publicKeyPem, 'publicKeyPem', 16 * 1024)
  };
  if (raw.version === 1) {
    return {
      version: 1,
      ...base,
      privateKeyPem: boundedString(raw.privateKeyPem, 'privateKeyPem', 64 * 1024)
    };
  }
  if (raw.version === 2) {
    if (!raw.privateKeyProtection || typeof raw.privateKeyProtection !== 'object') {
      throw new OperatorError('DEVICE_IDENTITY_INVALID', 'Protected device identity is missing privateKeyProtection.');
    }
    const protection = raw.privateKeyProtection as Record<string, unknown>;
    if (protection.scheme !== DPAPI_SCHEME || protection.keyFormat !== 'pkcs8-der') {
      throw new OperatorError('DEVICE_IDENTITY_INVALID', 'Protected device identity uses an unsupported protection format.');
    }
    const ciphertextBase64 = boundedString(protection.ciphertextBase64, 'ciphertextBase64', MAX_HELPER_OUTPUT_BYTES * 2);
    decodeCiphertext(ciphertextBase64).fill(0);
    return {
      version: 2,
      ...base,
      privateKeyProtection: {
        scheme: DPAPI_SCHEME,
        keyFormat: 'pkcs8-der',
        ciphertextBase64
      }
    };
  }
  throw new OperatorError('DEVICE_IDENTITY_INVALID', 'Unsupported device identity version.');
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) {
    throw new OperatorError('DEVICE_IDENTITY_INVALID', `Device identity field ${field} is invalid.`);
  }
  return value;
}

function decodeCiphertext(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new OperatorError('DEVICE_IDENTITY_INVALID', 'Protected device key ciphertext is not valid base64.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.length > MAX_HELPER_OUTPUT_BYTES || decoded.toString('base64') !== value) {
    decoded.fill(0);
    throw new OperatorError('DEVICE_IDENTITY_INVALID', 'Protected device key ciphertext is invalid.');
  }
  return decoded;
}

async function writeExclusiveJson(file: string, value: StoredIdentity): Promise<void> {
  await fs.writeFile(file, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

async function replaceJsonAtomic(file: string, value: StoredIdentity): Promise<void> {
  await writeDurableStateText(file, JSON.stringify(value, null, 2), {
    maxBytes: MAX_IDENTITY_BYTES,
    errorCode: 'DEVICE_IDENTITY_INVALID',
    invalidMessage: 'Device identity file is invalid.'
  });
}

function publicIdentity(stored: StoredIdentity): PublicDeviceIdentity {
  return {
    deviceId: stored.deviceId,
    deviceName: stored.deviceName,
    createdAt: stored.createdAt,
    publicKeyPem: stored.publicKeyPem,
    fingerprint: crypto.createHash('sha256').update(stored.publicKeyPem).digest('base64url')
  };
}
