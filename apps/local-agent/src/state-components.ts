import { AuditLog } from '../../../src/core/audit.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore } from '../../../src/core/device-registry.ts';
import { TaskStore } from '../../../src/core/task-store.ts';
import { EmergencyStopStore } from './emergency-stop.ts';
import { ApprovalStore } from './approval-store.ts';
import { LocalActionExecutionStore } from './action-execution-store.ts';
import { SessionApprovalStore } from './session-approval.ts';
import { LocalPrivacyDataStore } from './privacy-data.ts';
import { ResourceLeaseStore } from '../../../src/core/resource-leases.ts';
import { ActionTransitionJournal } from '../../../src/core/action-transition-journal.ts';
import { IntentRegistry } from '../../../src/core/intent-registry.ts';
import { ProcedureMemoryStore } from '../../../src/core/procedure-memory.ts';
import { WorldModelStore } from '../../../src/core/world-model.ts';
import { PerceptionGraphStore } from '../../../src/core/perception-graph.ts';
import { ExecutionOptimizerStore } from '../../../src/core/execution-optimizer.ts';
import { BoundedTaskIntelligence } from '../../../src/core/task-intelligence.ts';
import { SemanticCheckpointManager } from '../../../src/core/semantic-checkpoint.ts';
import { DeviceRoutingStore } from '../../../src/core/device-routing.ts';
import { DevicePoolScheduler } from '../../../src/core/device-pool.ts';
import { EnterprisePolicyStore } from '../../../src/core/enterprise-policy.ts';
import { DurableEventRuntime } from '../../../src/core/event-runtime.ts';

export async function createLocalStateComponents(stateDir: string) {
  const emergencyStop = new EmergencyStopStore(stateDir);
  const approvals = new ApprovalStore(stateDir);
  const actionExecutions = new LocalActionExecutionStore(stateDir);
  const sessionApprovals = new SessionApprovalStore();
  const deviceIdentity = new DeviceIdentityStore(stateDir);
  const localDeviceIdentity = await deviceIdentity.loadOrCreate();
  const audit = new AuditLog(stateDir, {
    authenticator: {
      keyId: localDeviceIdentity.fingerprint,
      sign: async (payload) => await deviceIdentity.sign(payload),
      verify: async (payload, signature) => await deviceIdentity.verify(payload, signature)
    }
  });
  const tasks = new TaskStore(stateDir);
  const resourceLeases = new ResourceLeaseStore(stateDir);
  const actionJournal = new ActionTransitionJournal(stateDir);
  const intentRegistry = new IntentRegistry(stateDir);
  const procedures = new ProcedureMemoryStore(stateDir);
  const world = new WorldModelStore(stateDir);
  const perception = new PerceptionGraphStore(stateDir);
  const optimizer = new ExecutionOptimizerStore(stateDir);
  const taskIntelligence = new BoundedTaskIntelligence({ world, procedures, perception, optimizer });
  const deviceRegistry = new DeviceRegistryStore(stateDir);
  const semanticMigration = new SemanticCheckpointManager(stateDir, {
    identity: deviceIdentity,
    registry: deviceRegistry
  });
  const deviceRouting = new DeviceRoutingStore(stateDir, deviceRegistry);
  const devicePool = new DevicePoolScheduler(stateDir, deviceRegistry, deviceRouting);
  const enterprisePolicy = new EnterprisePolicyStore(stateDir);
  const events = new DurableEventRuntime(stateDir);
  const privacy = new LocalPrivacyDataStore(stateDir);

  return {
    emergencyStop,
    approvals,
    actionExecutions,
    sessionApprovals,
    audit,
    tasks,
    resourceLeases,
    actionJournal,
    intentRegistry,
    procedures,
    world,
    perception,
    optimizer,
    taskIntelligence,
    deviceIdentity,
    deviceRegistry,
    semanticMigration,
    deviceRouting,
    devicePool,
    enterprisePolicy,
    events,
    privacy
  };
}

export type LocalStateComponents = Awaited<ReturnType<typeof createLocalStateComponents>>;
