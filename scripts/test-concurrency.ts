// Windows native process-tree/security integration tests share global OS
// process-observation resources. Run files serially to prevent concurrent
// tests from starving or obstructing child-process teardown. Other hosts
// retain a small generic parallelism bound.
const MAX_FILE_WORKERS = 2;

export function boundedTestConcurrency(availableParallelism: number, platform: NodeJS.Platform = process.platform): number {
  if (!Number.isSafeInteger(availableParallelism) || availableParallelism < 1) {
    throw new Error('Available test parallelism must be a positive safe integer.');
  }
  return platform === 'win32' ? 1 : Math.min(MAX_FILE_WORKERS, availableParallelism);
}
