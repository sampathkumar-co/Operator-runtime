// Bounded across platforms: reserve headroom for child processes, file I/O and
// runtime-internal workers during parallel integration test execution.
const MAX_FILE_WORKERS = 4;

export function boundedTestConcurrency(availableParallelism: number): number {
  if (!Number.isSafeInteger(availableParallelism) || availableParallelism < 1) {
    throw new Error('Available test parallelism must be a positive safe integer.');
  }
  return Math.min(MAX_FILE_WORKERS, availableParallelism);
}
