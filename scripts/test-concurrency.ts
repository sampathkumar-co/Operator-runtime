// Test files spawn additional terminal, Git and filesystem workloads.
// Keep enough scheduler headroom for *child* processes on modest and busy hosts.
const MAX_FILE_WORKERS = 2;

export function boundedTestConcurrency(availableParallelism: number): number {
  if (!Number.isSafeInteger(availableParallelism) || availableParallelism < 1) {
    throw new Error('Available test parallelism must be a positive safe integer.');
  }
  return Math.min(MAX_FILE_WORKERS, availableParallelism);
}
