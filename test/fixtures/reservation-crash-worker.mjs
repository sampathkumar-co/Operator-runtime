import { DevicePoolScheduler, devicePoolAllocationRequestDigest } from '../../src/core/device-pool.ts';
import { DeviceRegistryStore } from '../../src/core/device-registry.ts';
import { DeviceRoutingStore } from '../../src/core/device-routing.ts';
import { DurableCompensationJournal } from '../../src/core/compensation-journal.ts';

// Launched as an independent OS process. The parent SIGKILLs at the named
// durable transition: no exception handlers or graceful cleanup run here.
const [state, deviceId, sessionId, reservationId, intentId, stage] = process.argv.slice(2);
const journal = new DurableCompensationJournal(state);
const request = { workloadKey: 'crash-injection-workload' };
const allocationRequestDigest = devicePoolAllocationRequestDigest(request);
await journal.prepare({
  id: intentId,
  ownerKind: 'digital-operation',
  ownerId: 'crash-injection-owner',
  operation: 'release-device-reservation',
  targetId: reservationId,
  allocationRequestDigest
});
if (stage !== 'prepared') {
  const registry = new DeviceRegistryStore(state);
  const scheduler = new DevicePoolScheduler(state, registry, new DeviceRoutingStore(state, registry));
  await scheduler.reserve(request, [{
    deviceId, sessionId, capabilities: ['file.read'],
    observedAt: new Date().toISOString(), cpuSlots: 2, memoryMb: 4096,
    gpu: false, tags: [], activeJobs: 0, maxConcurrentJobs: 1
  }], { reservationId });
}
if (stage === 'confirmed') await journal.confirm(intentId);
process.stdout.write('CRASH_POINT_REACHED:' + stage + '\n');
setInterval(() => {}, 60_000);
