import { LocalActionExecutionStore } from '../../apps/local-agent/src/action-execution-store.ts';
import { ActionTransitionJournal } from '../../src/core/action-transition-journal.ts';

const stateDir = process.argv[2];
if (!stateDir) throw new Error('Missing isolated state directory');
const action = {
  id: 'cross-process-prepared-action',
  capability: 'app.operate',
  risk: 'external',
  input: { operation: 'select', selector: { automationId: 'one-tab', controlType: 'TabItem' } },
  provenance: { kind: 'chatgpt' }
};
await new LocalActionExecutionStore(stateDir).begin(action);
await new ActionTransitionJournal(stateDir).prepare({
  action, ownerKind: 'local-api', ownerId: action.id,
  resourceKeys: ['application:uia']
});
// Deliberately exit with no dispatch: the parent tests real OS death
// evidence rather than injecting a synthetic dead-PID observer.
