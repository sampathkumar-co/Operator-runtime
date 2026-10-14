// Real process-death fixture. Never touches anything outside caller's synthetic temp root.
// The parent must kill this process only AFTER the device reservation persists,
// intentionally before DigitalOperationsLayer can confirm its prepared compensation.
import { ProcedureMemoryStore } from '../../src/core/procedure-memory.ts';
import { WorldModelStore } from '../../src/core/world-model.ts';
import { DeviceRegistryStore } from '../../src/core/device-registry.ts';
import { DeviceRoutingStore } from '../../src/core/device-routing.ts';
import { DevicePoolScheduler } from '../../src/core/device-pool.ts';
import { TeamCoordinator } from '../../src/core/team-coordinator.ts';
import { OrganizationCoordinator } from '../../src/core/organization-coordinator.ts';
import { DigitalOperationsLayer } from '../../src/core/digital-operations.ts';

const [state, requestId, deviceId, sessionId] = process.argv.slice(2);
if (![state, requestId, deviceId, sessionId].every(Boolean)) {
  throw new Error('Synthetic root, UUIDs, device and session are required');
}
const registry = new DeviceRegistryStore(state);
const pool = new DevicePoolScheduler(state, registry, new DeviceRoutingStore(state, registry));
const devices = Object.create(pool);
devices.reserve = async (...args) => {
  const reservation = await pool.reserve(...args);
  process.stdout.write('RESERVATION_PERSISTED:' + reservation.id + '\n');
  // Keep a real owner process alive until the parent injects the hard kill.
  // An unresolved Promise alone does not keep Node's event loop active.
  setInterval(() => {}, 1000);
  await new Promise(() => {});
};
const team = new TeamCoordinator(state);
const layer = new DigitalOperationsLayer(state, {
  procedures: new ProcedureMemoryStore(state),
  world: new WorldModelStore(state),
  devices,
  optimizer: { async recommend() { return [{ id: 'fresh-plan' }]; } },
  teams: team,
  organizations: new OrganizationCoordinator(state, team),
  availableCapabilities: ['file.read']
});
await layer.submit({
  requestId,
  objective: 'Crash after exact device allocation but before compensation confirmation',
  scopeKey: 'project:synthetic-reservation-crash',
  successConditions: ['exact durable allocation recovered'],
  device: {
    request: { workloadKey: 'exact-allocation-crash-recovery', slots: 1 },
    advertisements: [{
      deviceId, sessionId, capabilities: ['file.read'], observedAt: new Date().toISOString(),
      cpuSlots: 8, memoryMb: 8192, gpu: false, tags: [],
      activeJobs: 0, maxConcurrentJobs: 1
    }]
  },
  execution: { kind: 'team', workItems: [
    { key: 'check', title: 'Inspect synthetic crash recovery', role: 'general', risk: 'read' },
    { key: 'verify', title: 'Verify crash recovery', role: 'verifier', risk: 'read', dependsOn: ['check'] }
  ] },
  run: false
});
throw new Error('Crash fixture unexpectedly returned from reserve()');
