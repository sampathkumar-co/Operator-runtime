import { ProcedureMemoryStore } from '../../src/core/procedure-memory.ts';
import { WorldModelStore } from '../../src/core/world-model.ts';
import { DeviceRegistryStore } from '../../src/core/device-registry.ts';
import { DeviceRoutingStore } from '../../src/core/device-routing.ts';
import { DevicePoolScheduler } from '../../src/core/device-pool.ts';
import { TeamCoordinator } from '../../src/core/team-coordinator.ts';
import { OrganizationCoordinator } from '../../src/core/organization-coordinator.ts';
import { DigitalOperationsLayer } from '../../src/core/digital-operations.ts';

const [state, requestId] = process.argv.slice(2);
if (!state || !requestId) throw new Error('Expected isolated state and requested UUID');
const teams = new TeamCoordinator(state);
const registry = new DeviceRegistryStore(state);
const deps = {
  procedures: new ProcedureMemoryStore(state),
  world: new WorldModelStore(state),
  devices: new DevicePoolScheduler(state, registry, new DeviceRoutingStore(state, registry)),
  optimizer: {
    async recommend() {
      // DigitalOperationsLayer MUST durably commit the non-recyclable request
      // identity before reaching this paused downstream optimization step.
      process.stdout.write('ID_BURNED_BEFORE_EFFECT\n');
      setInterval(() => {}, 1000);
      return await new Promise(() => {});
    }
  },
  teams,
  organizations: new OrganizationCoordinator(state, teams)
};
const ops = new DigitalOperationsLayer(state, deps);
await ops.submit({
  requestId, objective: 'Crash after durable request identity commit',
  scopeKey: 'project:crash-burn-request',
  successConditions: ['no deterministic mission replay'],
  execution: { kind: 'team', workItems: [
    { key: 'safe', role: 'general', title: 'Observe crash boundary', risk: 'read' },
    { key: 'verify', role: 'verifier', title: 'Verify no replay', risk: 'read', dependsOn: ['safe'] }
  ] }, run: false
});
throw new Error('Fixture unexpectedly escaped the paused downstream stage');
