import fs from 'node:fs/promises';
import path from 'node:path';

export type PrivacyCategory = 'activity' | 'tasks' | 'session-state';

export interface PrivacyCategoryStatus {
  category: PrivacyCategory | 'device-identity' | 'pairing-state';
  bytes: number;
  entries: number;
  present: boolean;
  deletable: boolean;
}

const MAX_COUNTED_ENTRIES = 10_000;

export class LocalPrivacyDataStore {
  #stateDir: string;

  constructor(stateDir: string) {
    this.#stateDir = path.resolve(stateDir);
  }

  async inventory(): Promise<PrivacyCategoryStatus[]> {
    return [
      await this.#status('activity', ['audit.ndjson'], true),
      await this.#status('tasks', ['tasks'], true),
      await this.#status('session-state', ['relay-client.json', 'device-sessions.json'], true),
      await this.#status('device-identity', ['device-identity.json'], false),
      await this.#status('pairing-state', ['device-registry.json', 'device-routing.json'], false)
    ];
  }

  async purge(category: PrivacyCategory): Promise<{ category: PrivacyCategory; removedBytes: number; removedEntries: number }> {
    const before = (await this.inventory()).find((item) => item.category === category);
    if (!before) throw new Error('Unknown privacy category.');
    const targets = category === 'activity'
      ? ['audit.ndjson']
      : category === 'tasks'
        ? ['tasks']
        : ['relay-client.json', 'device-sessions.json'];

    for (const relative of targets) {
      const target = this.#target(relative);
      await this.#assertSafeKnownTarget(target);
    }
    for (const relative of targets) {
      const target = this.#target(relative);
      await fs.rm(target, { recursive: true, force: true });
    }
    return { category, removedBytes: before.bytes, removedEntries: before.entries };
  }

  async #status(category: PrivacyCategoryStatus['category'], relatives: string[], deletable: boolean): Promise<PrivacyCategoryStatus> {
    let bytes = 0;
    let entries = 0;
    for (const relative of relatives) {
      const counted = await countKnownPath(this.#target(relative));
      bytes += counted.bytes;
      entries += counted.entries;
      if (entries > MAX_COUNTED_ENTRIES) throw new Error('Privacy inventory exceeds the bounded entry count.');
    }
    return { category, bytes, entries, present: entries > 0, deletable };
  }

  #target(relative: string): string {
    const target = path.resolve(this.#stateDir, relative);
    const rel = path.relative(this.#stateDir, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Privacy data target escaped the Operator state directory.');
    return target;
  }

  async #assertSafeKnownTarget(target: string): Promise<void> {
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new Error('Privacy data target must not be a symbolic link.');
      if (stat.isDirectory()) await assertTreeHasNoSymlinks(target, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function countKnownPath(target: string): Promise<{ bytes: number; entries: number }> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error('Privacy inventory refuses symbolic links.');
    if (stat.isFile()) return { bytes: stat.size, entries: 1 };
    if (!stat.isDirectory()) return { bytes: 0, entries: 1 };
    return await countDirectory(target, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, entries: 0 };
    throw error;
  }
}

async function countDirectory(dir: string, seen: number): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 1;
  const names = await fs.readdir(dir);
  for (const name of names) {
    if (seen + entries > MAX_COUNTED_ENTRIES) throw new Error('Privacy inventory exceeds the bounded entry count.');
    const child = path.join(dir, name);
    const stat = await fs.lstat(child);
    if (stat.isSymbolicLink()) throw new Error('Privacy inventory refuses symbolic links.');
    if (stat.isDirectory()) {
      const nested = await countDirectory(child, seen + entries);
      bytes += nested.bytes;
      entries += nested.entries;
    } else {
      bytes += stat.size;
      entries += 1;
    }
  }
  return { bytes, entries };
}

async function assertTreeHasNoSymlinks(dir: string, seen: number): Promise<number> {
  let count = seen;
  for (const name of await fs.readdir(dir)) {
    count += 1;
    if (count > MAX_COUNTED_ENTRIES) throw new Error('Privacy deletion exceeds the bounded entry count.');
    const child = path.join(dir, name);
    const stat = await fs.lstat(child);
    if (stat.isSymbolicLink()) throw new Error('Privacy deletion refuses symbolic links.');
    if (stat.isDirectory()) count = await assertTreeHasNoSymlinks(child, count);
  }
  return count;
}
