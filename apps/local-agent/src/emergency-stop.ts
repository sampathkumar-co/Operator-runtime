import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_REASON = 512;

type EmergencyStopState = {
  version: 1;
  engaged: boolean;
  engagedAt?: string;
  reason?: string;
  clearedAt?: string;
};

export class EmergencyStopStore {
  #file: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.#file = path.join(path.resolve(stateDir), 'emergency-stop.json');
  }

  async status(): Promise<Readonly<EmergencyStopState>> {
    return await this.#read();
  }

  async engage(reasonInput?: string): Promise<Readonly<EmergencyStopState>> {
    const reason = reasonInput === undefined ? undefined : validReason(reasonInput);
    return await this.#mutate((current) => {
      if (current.engaged) return current;
      return {
        version: 1,
        engaged: true,
        engagedAt: new Date().toISOString(),
        reason
      };
    });
  }

  async clear(): Promise<Readonly<EmergencyStopState>> {
    return await this.#mutate(() => ({
      version: 1,
      engaged: false,
      clearedAt: new Date().toISOString()
    }));
  }

  async #read(): Promise<EmergencyStopState> {
    try {
      const stat = await fs.stat(this.#file);
      if (!stat.isFile() || stat.size > 16 * 1024) throw new Error('invalid emergency-stop file');
      return validateState(JSON.parse(await fs.readFile(this.#file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, engaged: false };
      throw new Error(`Emergency stop state could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #write(stateInput: EmergencyStopState): Promise<void> {
    const state = validateState(stateInput);
    await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temp = `${this.#file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temp, this.#file);
  }

  async #mutate(mutator: (state: EmergencyStopState) => EmergencyStopState): Promise<EmergencyStopState> {
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const next = mutator(await this.#read());
      await this.#write(next);
      return next;
    } finally {
      release();
    }
  }
}

function validReason(value: string): string {
  const reason = value.trim();
  if (!reason || reason.length > MAX_REASON || /\0/.test(reason)) throw new Error('Emergency stop reason is invalid.');
  return reason;
}

function validateState(input: any): EmergencyStopState {
  if (!input || input.version !== 1 || typeof input.engaged !== 'boolean') throw new Error('Emergency stop state structure is invalid.');
  const engagedAt = input.engagedAt === undefined ? undefined : validIso(String(input.engagedAt));
  const clearedAt = input.clearedAt === undefined ? undefined : validIso(String(input.clearedAt));
  const reason = input.reason === undefined ? undefined : validReason(String(input.reason));
  if (input.engaged && !engagedAt) throw new Error('Engaged emergency stop requires engagedAt.');
  if (!input.engaged && (engagedAt || reason)) throw new Error('Cleared emergency stop cannot retain engagement metadata.');
  return { version: 1, engaged: input.engaged, engagedAt, reason, clearedAt };
}

function validIso(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error('Emergency stop timestamp is invalid.');
  return value;
}
