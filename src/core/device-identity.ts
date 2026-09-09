import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { OperatorError } from './errors.ts';

interface StoredIdentity {
  version: 1;
  deviceId: string;
  deviceName: string;
  createdAt: string;
  publicKeyPem: string;
  privateKeyPem: string;
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

  constructor(stateDir: string) {
    this.#file = path.join(path.resolve(stateDir), 'device-identity.json');
  }

  async loadOrCreate(deviceName = os.hostname()): Promise<PublicDeviceIdentity> {
    let stored: StoredIdentity;
    try {
      stored = JSON.parse(await fs.readFile(this.#file, 'utf8')) as StoredIdentity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      stored = await this.#create(deviceName);
    }
    return publicIdentity(stored);
  }

  async sign(payload: Uint8Array): Promise<string> {
    const stored = await this.#loadPrivate();
    return crypto.sign(null, payload, stored.privateKeyPem).toString('base64url');
  }

  async verify(payload: Uint8Array, signature: string): Promise<boolean> {
    const stored = await this.#loadPrivate();
    return crypto.verify(null, payload, stored.publicKeyPem, Buffer.from(signature, 'base64url'));
  }

  async #create(deviceName: string): Promise<StoredIdentity> {
    await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const stored: StoredIdentity = {
      version: 1,
      deviceId: crypto.randomUUID(),
      deviceName,
      createdAt: new Date().toISOString(),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    };
    await fs.writeFile(this.#file, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return stored;
  }

  async #loadPrivate(): Promise<StoredIdentity> {
    try { return JSON.parse(await fs.readFile(this.#file, 'utf8')) as StoredIdentity; }
    catch { throw new OperatorError('DEVICE_IDENTITY_MISSING', 'Device identity has not been created.'); }
  }
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
