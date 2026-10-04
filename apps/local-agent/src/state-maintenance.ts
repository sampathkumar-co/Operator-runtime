import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { OperatorError } from '../../../src/core/errors.ts';
import { StateSnapshotManager, type SnapshotManifest } from '../../../src/core/state-snapshot.ts';
import { acquireLocalAgentStateInstanceLock } from './state-instance-lock.ts';

/**
 * Runs snapshot maintenance with exclusive ownership of the complete local
 * state directory. The normal agent acquires the same process-instance lock
 * before constructing any store or provider, so this is a production global
 * quiescence boundary rather than a per-store pause.
 */
export async function runOfflineStateSnapshot(input: {
  operation: 'create' | 'restore' | 'verify';
  stateDir: string;
  snapshotRoot: string;
  epoch?: string;
  signal?: AbortSignal;
}): Promise<SnapshotManifest> {
  const stateDir = path.resolve(input.stateDir);
  const manager = new StateSnapshotManager(stateDir, path.resolve(input.snapshotRoot));
  if (input.operation === 'verify') {
    if (!input.epoch) throw new OperatorError('SNAPSHOT_EPOCH_REQUIRED', 'Snapshot verification requires an epoch.');
    return await manager.verify(input.epoch);
  }

  const lock = await acquireLocalAgentStateInstanceLock(stateDir);
  try {
    const exclusivelyQuiescent = async <T>(operation: () => Promise<T>): Promise<T> => await operation();
    if (input.operation === 'create') {
      return await manager.create({
        ...(input.epoch ? { epoch: input.epoch } : {}),
        withQuiescence: exclusivelyQuiescent,
        signal: input.signal
      });
    }
    if (!input.epoch) throw new OperatorError('SNAPSHOT_EPOCH_REQUIRED', 'Snapshot restore requires an epoch.');
    return await manager.restore({ epoch: input.epoch, withQuiescence: exclusivelyQuiescent, signal: input.signal });
  } finally {
    await lock.release();
  }
}

async function main(): Promise<void> {
  const operation = process.argv[2] as 'create' | 'restore' | 'verify' | undefined;
  const stateDir = process.env.OPERATOR_STATE_DIR;
  const snapshotRoot = process.env.OPERATOR_SNAPSHOT_ROOT;
  const epoch = process.argv[3];
  if (!operation || !['create', 'restore', 'verify'].includes(operation) || !stateDir || !snapshotRoot) {
    throw new OperatorError(
      'SNAPSHOT_COMMAND_INVALID',
      'Usage: OPERATOR_STATE_DIR=<state> OPERATOR_SNAPSHOT_ROOT=<snapshots> npm run state:snapshot -- <create|verify|restore> [epoch]'
    );
  }
  const manifest = await runOfflineStateSnapshot({ operation, stateDir, snapshotRoot, ...(epoch ? { epoch } : {}) });
  process.stdout.write(`${JSON.stringify({ ok: true, operation, epoch: manifest.epoch, manifestDigest: manifest.manifestDigest })}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`state snapshot maintenance failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
