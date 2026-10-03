import crypto from 'node:crypto';
import path from 'node:path';
import { actionHash, canonicalJson } from './action-identity.ts';
import type { AgentKernel } from './agent-kernel.ts';
import { kernelVerificationDigest } from './action-verification.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { OperatorError } from './errors.ts';
import type { ActionRequest, IntentBinding, PermissionProfile } from './types.ts';
import { validIntentBinding } from './intent-registry.ts';

export type DurableSagaState =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPENSATING'
  | 'BLOCKED'
  | 'FAILED'
  | 'COMPLETED'
  | 'COMPENSATED';

export type DurableSagaStepState =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'COMPENSATING'
  | 'COMPENSATED'
  | 'FAILED'
  | 'BLOCKED';

export interface DurableSagaStep {
  key: string;
  action: ActionRequest;
  compensation?: ActionRequest;
  state: DurableSagaStepState;
  actionDigest: string;
  compensationDigest?: string;
  verificationDigest?: string;
  compensationVerificationDigest?: string;
  provider?: string;
  errorCode?: string;
  updatedAt: string;
}

export interface DurableSaga {
  version: 1;
  id: string;
  contractDigest: string;
  objective: string;
  intent?: IntentBinding;
  state: DurableSagaState;
  steps: DurableSagaStep[];
  createdAt: string;
  updatedAt: string;
}

interface SagaStateFile {
  version: 1;
  sagas: DurableSaga[];
}

const MAX_SAGAS = 1000;
const MAX_STEPS = 100;
const STORE_OPTIONS = {
  maxBytes: 64 * 1024 * 1024,
  errorCode: 'SAGA_STATE_CORRUPT',
  invalidMessage: 'Durable saga state is invalid.'
} as const;

export class DurableSagaKernel {
  #file: string;
  #kernel: AgentKernel;
  #permissions: PermissionProfile;
  #serial: Promise<void> = Promise.resolve();
  #active = new Map<string, Promise<DurableSaga>>();

  constructor(stateDir: string, options: { kernel: AgentKernel; permissions: PermissionProfile }) {
    this.#file = path.join(path.resolve(stateDir), 'durable-sagas.json');
    this.#kernel = options.kernel;
    this.#permissions = structuredClone(options.permissions);
  }

  async submit(input: {
    sagaId?: string;
    objective: string;
    intent?: IntentBinding;
    steps: Array<{ key: string; action: ActionRequest; compensation?: ActionRequest }>;
  }): Promise<DurableSaga> {
    const objective = bounded(input.objective, 16_384, 'objective');
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > MAX_STEPS) {
      throw new OperatorError('SAGA_INPUT_INVALID', `Saga requires 1-${MAX_STEPS} steps.`);
    }
    const id = input.sagaId === undefined ? crypto.randomUUID() : uuid(input.sagaId, 'sagaId');
    const intent = input.intent ? validIntentBinding(input.intent) : undefined;
    const keys = new Set<string>();
    const normalized = input.steps.map((step, index) => {
      const key = boundedKey(step.key, `steps[${index}].key`);
      if (keys.has(key)) throw new OperatorError('SAGA_INPUT_INVALID', `Duplicate saga step key ${key}.`);
      keys.add(key);
      const action = bindAction(step.action, id, intent);
      const compensation = step.compensation ? bindAction(step.compensation, id, intent) : undefined;
      if (compensation && compensation.id === action.id) {
        throw new OperatorError('SAGA_INPUT_INVALID', `Step ${key} action and compensation must use different action ids.`);
      }
      return {
        key,
        action,
        ...(compensation ? { compensation } : {}),
        actionDigest: actionHash(action),
        ...(compensation ? { compensationDigest: actionHash(compensation) } : {})
      };
    });
    const contractDigest = digest({
      version: 1,
      id,
      objective,
      intent: intent ?? null,
      steps: normalized.map((step) => ({
        key: step.key,
        actionDigest: step.actionDigest,
        compensationDigest: step.compensationDigest ?? null
      }))
    });

    return await this.#mutate((state, now) => {
      const existing = state.sagas.find((saga) => saga.id === id);
      if (existing) {
        if (existing.contractDigest !== contractDigest) {
          throw new OperatorError('SAGA_ID_CONFLICT', 'Saga id is already bound to a different immutable execution contract.');
        }
        return existing;
      }
      if (state.sagas.length >= MAX_SAGAS) {
        const reclaim = state.sagas
          .filter((saga) => ['COMPLETED','COMPENSATED','FAILED'].includes(saga.state))
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
        if (!reclaim) throw new OperatorError('SAGA_LIMIT', 'Durable saga retention limit reached.');
        state.sagas.splice(state.sagas.findIndex((saga) => saga.id === reclaim.id), 1);
      }
      const at = now.toISOString();
      const saga: DurableSaga = {
        version: 1,
        id,
        contractDigest,
        objective,
        ...(intent ? { intent } : {}),
        state: 'PENDING',
        steps: normalized.map((step) => ({
          ...structuredClone(step),
          state: 'PENDING',
          updatedAt: at
        })),
        createdAt: at,
        updatedAt: at
      };
      state.sagas.push(saga);
      return saga;
    });
  }

  async inspect(sagaId: string): Promise<DurableSaga> {
    await this.#serial;
    const state = await this.#read();
    const saga = state.sagas.find((item) => item.id === uuid(sagaId, 'sagaId'));
    if (!saga) throw new OperatorError('SAGA_NOT_FOUND', 'Durable saga was not found.');
    return structuredClone(saga);
  }

  async list(limitInput = 100): Promise<DurableSaga[]> {
    await this.#serial;
    const limit = integer(limitInput, 1, 500, 'limit');
    const state = await this.#read();
    return state.sagas.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map((item) => structuredClone(item));
  }

  async run(sagaIdInput: string, options: { signal?: AbortSignal } = {}): Promise<DurableSaga> {
    const sagaId = uuid(sagaIdInput, 'sagaId');
    const active = this.#active.get(sagaId);
    if (active) return await active;
    const promise = this.#run(sagaId, options).finally(() => this.#active.delete(sagaId));
    this.#active.set(sagaId, promise);
    return await promise;
  }

  async #run(sagaId: string, options: { signal?: AbortSignal }): Promise<DurableSaga> {
    let saga = await this.inspect(sagaId);
    if (['COMPLETED','COMPENSATED','FAILED'].includes(saga.state)) return saga;

    saga = await this.#recoverInterrupted(saga);
    if (saga.state === 'BLOCKED') return saga;

    if (saga.state === 'COMPENSATING') return await this.#compensate(saga, options.signal);

    await this.#update(saga.id, (current, now) => {
      current.state = 'RUNNING';
      current.updatedAt = now.toISOString();
    });

    for (const step of (await this.inspect(saga.id)).steps) {
      if (step.state === 'COMPLETED' || step.state === 'COMPENSATED') continue;
      if (options.signal?.aborted) return await this.inspect(saga.id);
      if (step.state !== 'PENDING') {
        throw new OperatorError('SAGA_STATE_CORRUPT', `Saga step ${step.key} cannot execute from state ${step.state}.`);
      }
      await this.#update(saga.id, (current, now) => {
        const target = requireStep(current, step.key);
        target.state = 'RUNNING';
        target.updatedAt = now.toISOString();
        current.updatedAt = target.updatedAt;
      });

      const result = await this.#kernel.execute(step.action, this.#permissions, {
        signal: options.signal,
        ownerKind: 'saga',
        ownerId: saga.id,
        learningContext: `saga:${saga.id}`
      });
      const verificationDigest = kernelVerificationDigest(result);
      if (result.ok && verificationDigest) {
        await this.#update(saga.id, (current, now) => {
          const target = requireStep(current, step.key);
          target.state = 'COMPLETED';
          target.provider = result.provider;
          target.verificationDigest = verificationDigest;
          target.updatedAt = now.toISOString();
          current.updatedAt = target.updatedAt;
        });
        continue;
      }

      const uncertain = result.error?.sideEffectState === 'uncertain' || result.error?.code === 'ACTION_RECONCILIATION_REQUIRED';
      await this.#update(saga.id, (current, now) => {
        const target = requireStep(current, step.key);
        target.state = uncertain ? 'BLOCKED' : 'FAILED';
        target.provider = result.provider;
        target.errorCode = result.error?.code ?? 'SAGA_STEP_FAILED';
        target.updatedAt = now.toISOString();
        current.state = uncertain ? 'BLOCKED' : 'COMPENSATING';
        current.updatedAt = target.updatedAt;
      });
      if (uncertain) return await this.inspect(saga.id);
      return await this.#compensate(await this.inspect(saga.id), options.signal);
    }

    return await this.#update(saga.id, (current, now) => {
      if (!current.steps.every((step) => step.state === 'COMPLETED')) {
        throw new OperatorError('SAGA_STATE_CORRUPT', 'Saga cannot complete while a step remains unresolved.');
      }
      current.state = 'COMPLETED';
      current.updatedAt = now.toISOString();
    });
  }

  async #recoverInterrupted(saga: DurableSaga): Promise<DurableSaga> {
    for (const step of saga.steps) {
      if (step.state !== 'RUNNING' && step.state !== 'COMPENSATING') continue;
      const action = step.state === 'COMPENSATING' ? step.compensation : step.action;
      if (!action) {
        saga = await this.#update(saga.id, (current, now) => {
          const target = requireStep(current, step.key);
          target.state = 'COMPENSATED';
          target.updatedAt = now.toISOString();
          current.updatedAt = target.updatedAt;
        });
        continue;
      }

      let journal;
      try {
        journal = await this.#kernel.journal.inspect(action.id);
      } catch (error) {
        if (error instanceof OperatorError && error.code === 'ACTION_JOURNAL_NOT_FOUND') {
          saga = await this.#update(saga.id, (current, now) => {
            const target = requireStep(current, step.key);
            target.state = step.state === 'COMPENSATING' ? 'PENDING' : 'PENDING';
            target.updatedAt = now.toISOString();
            current.updatedAt = target.updatedAt;
          });
          continue;
        }
        throw error;
      }

      if (journal.state === 'COMPLETED') {
        const verificationDigest = latestVerificationDigest(journal);
        saga = await this.#update(saga.id, (current, now) => {
          const target = requireStep(current, step.key);
          if (step.state === 'COMPENSATING') {
            target.state = 'COMPENSATED';
            if (verificationDigest) target.compensationVerificationDigest = verificationDigest;
          } else {
            target.state = 'COMPLETED';
            if (verificationDigest) target.verificationDigest = verificationDigest;
          }
          target.updatedAt = now.toISOString();
          current.updatedAt = target.updatedAt;
        });
        continue;
      }

      if (journal.state === 'PREPARED' || journal.state === 'DEFERRED' || journal.state === 'RECONCILED') {
        saga = await this.#update(saga.id, (current, now) => {
          const target = requireStep(current, step.key);
          target.state = 'PENDING';
          target.updatedAt = now.toISOString();
          current.updatedAt = target.updatedAt;
        });
        continue;
      }

      const provider = [...journal.transitions].reverse().find((transition) => transition.provider)?.provider;
      if (!provider) {
        return await this.#blockRecovery(saga.id, step.key, 'SAGA_RECONCILIATION_PROVIDER_MISSING');
      }
      const reconciliation = await this.#kernel.reconcile(action, provider);
      if (reconciliation.status === 'completed' && reconciliation.result) {
        const verificationDigest = kernelVerificationDigest(reconciliation.result);
        saga = await this.#update(saga.id, (current, now) => {
          const target = requireStep(current, step.key);
          if (step.state === 'COMPENSATING') {
            target.state = 'COMPENSATED';
            if (verificationDigest) target.compensationVerificationDigest = verificationDigest;
          } else {
            target.state = 'COMPLETED';
            if (verificationDigest) target.verificationDigest = verificationDigest;
          }
          target.updatedAt = now.toISOString();
          current.updatedAt = target.updatedAt;
        });
      } else if (reconciliation.status === 'not_applied') {
        saga = await this.#update(saga.id, (current, now) => {
          const target = requireStep(current, step.key);
          target.state = 'PENDING';
          target.updatedAt = now.toISOString();
          current.updatedAt = target.updatedAt;
        });
      } else {
        return await this.#blockRecovery(saga.id, step.key, 'SAGA_RECONCILIATION_REQUIRED');
      }
    }
    saga = await this.inspect(saga.id);
    if (saga.state === 'BLOCKED') return saga;
    if (saga.state === 'RUNNING' && saga.steps.some((step) => step.state === 'FAILED')) {
      saga = await this.#update(saga.id, (current, now) => {
        current.state = 'COMPENSATING';
        current.updatedAt = now.toISOString();
      });
    }
    return saga;
  }

  async #compensate(saga: DurableSaga, signal?: AbortSignal): Promise<DurableSaga> {
    await this.#update(saga.id, (current, now) => {
      current.state = 'COMPENSATING';
      current.updatedAt = now.toISOString();
    });

    const completed = (await this.inspect(saga.id)).steps
      .filter((step) => step.state === 'COMPLETED' || step.state === 'COMPENSATING')
      .reverse();

    for (const step of completed) {
      if (signal?.aborted) return await this.inspect(saga.id);
      if (!step.compensation) {
        await this.#update(saga.id, (current, now) => {
          const target = requireStep(current, step.key);
          target.state = 'COMPENSATED';
          target.updatedAt = now.toISOString();
          current.updatedAt = target.updatedAt;
        });
        continue;
      }
      await this.#update(saga.id, (current, now) => {
        const target = requireStep(current, step.key);
        target.state = 'COMPENSATING';
        target.updatedAt = now.toISOString();
        current.updatedAt = target.updatedAt;
      });
      const result = await this.#kernel.execute(step.compensation, this.#permissions, {
        signal,
        ownerKind: 'saga-compensation',
        ownerId: saga.id,
        learningContext: `saga-compensation:${saga.id}`,
        recoveryMode: 'compensation'
      });
      const verificationDigest = kernelVerificationDigest(result);
      if (result.ok && verificationDigest) {
        await this.#update(saga.id, (current, now) => {
          const target = requireStep(current, step.key);
          target.state = 'COMPENSATED';
          target.provider = result.provider;
          target.compensationVerificationDigest = verificationDigest;
          target.updatedAt = now.toISOString();
          current.updatedAt = target.updatedAt;
        });
        continue;
      }
      const uncertain = result.error?.sideEffectState === 'uncertain' || result.error?.code === 'ACTION_RECONCILIATION_REQUIRED';
      return await this.#update(saga.id, (current, now) => {
        const target = requireStep(current, step.key);
        target.state = uncertain ? 'BLOCKED' : 'FAILED';
        target.errorCode = result.error?.code ?? 'SAGA_COMPENSATION_FAILED';
        target.updatedAt = now.toISOString();
        current.state = uncertain ? 'BLOCKED' : 'FAILED';
        current.updatedAt = target.updatedAt;
      });
    }

    return await this.#update(saga.id, (current, now) => {
      current.state = 'COMPENSATED';
      current.updatedAt = now.toISOString();
    });
  }

  async #blockRecovery(sagaId: string, stepKey: string, code: string): Promise<DurableSaga> {
    return await this.#update(sagaId, (current, now) => {
      const target = requireStep(current, stepKey);
      target.state = 'BLOCKED';
      target.errorCode = code;
      target.updatedAt = now.toISOString();
      current.state = 'BLOCKED';
      current.updatedAt = target.updatedAt;
    });
  }

  async #update(id: string, mutate: (saga: DurableSaga, now: Date) => void): Promise<DurableSaga> {
    return await this.#mutate((state, now) => {
      const saga = state.sagas.find((item) => item.id === id);
      if (!saga) throw new OperatorError('SAGA_NOT_FOUND', 'Durable saga was not found.');
      mutate(saga, now);
      return saga;
    });
  }

  async #read(): Promise<SagaStateFile> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sagas: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('SAGA_STATE_CORRUPT', 'Durable saga state could not be read.');
    }
  }

  async #mutate<T>(fn: (state: SagaStateFile, now: Date) => T | Promise<T>): Promise<T> {
    let output!: T;
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      output = await fn(state, new Date());
      validateState(state);
      await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return structuredClone(output);
  }
}

function bindAction(actionInput: ActionRequest, sagaId: string, intent?: IntentBinding): ActionRequest {
  if (!actionInput || typeof actionInput !== 'object') throw new OperatorError('SAGA_INPUT_INVALID', 'Saga action is invalid.');
  const action = structuredClone(actionInput);
  action.taskId = sagaId;
  if (intent) {
    if (action.intent && canonicalJson(action.intent) !== canonicalJson(intent)) {
      throw new OperatorError('SAGA_INTENT_CONFLICT', 'Saga action intent conflicts with the saga intent.');
    }
    action.intent = intent;
  }
  return action;
}

function validateState(input: unknown): SagaStateFile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const state = input as SagaStateFile;
  if (state.version !== 1 || !Array.isArray(state.sagas) || state.sagas.length > MAX_SAGAS) throw corrupt('State shape is invalid.');
  const ids = new Set<string>();
  for (const saga of state.sagas) {
    if (saga.version !== 1) throw corrupt('Saga version is invalid.');
    uuid(saga.id, 'saga.id');
    if (ids.has(saga.id)) throw corrupt('Saga ids must be unique.');
    ids.add(saga.id);
    sha(saga.contractDigest, 'contractDigest');
    bounded(saga.objective, 16_384, 'objective');
    if (saga.intent) validIntentBinding(saga.intent);
    if (!['PENDING','RUNNING','COMPENSATING','BLOCKED','FAILED','COMPLETED','COMPENSATED'].includes(saga.state)) throw corrupt('Saga state is invalid.');
    if (!Array.isArray(saga.steps) || saga.steps.length < 1 || saga.steps.length > MAX_STEPS) throw corrupt('Saga steps are invalid.');
    const keys = new Set<string>();
    for (const step of saga.steps) {
      boundedKey(step.key, 'step.key');
      if (keys.has(step.key)) throw corrupt('Saga step keys must be unique.');
      keys.add(step.key);
      if (!['PENDING','RUNNING','COMPLETED','COMPENSATING','COMPENSATED','FAILED','BLOCKED'].includes(step.state)) throw corrupt('Saga step state is invalid.');
      sha(step.actionDigest, 'actionDigest');
      if (step.actionDigest !== actionHash(step.action)) throw corrupt('Saga action digest changed.');
      if (step.compensation) {
        if (!step.compensationDigest || step.compensationDigest !== actionHash(step.compensation)) throw corrupt('Saga compensation digest changed.');
      } else if (step.compensationDigest !== undefined) throw corrupt('Compensation digest exists without compensation action.');
      if (step.verificationDigest) sha(step.verificationDigest, 'verificationDigest');
      if (step.compensationVerificationDigest) sha(step.compensationVerificationDigest, 'compensationVerificationDigest');
      if (step.provider !== undefined) bounded(step.provider, 256, 'provider');
      if (step.errorCode !== undefined) bounded(step.errorCode, 256, 'errorCode');
      iso(step.updatedAt);
    }
    iso(saga.createdAt); iso(saga.updatedAt);
  }
  return state;
}

function requireStep(saga: DurableSaga, key: string): DurableSagaStep {
  const step = saga.steps.find((item) => item.key === key);
  if (!step) throw new OperatorError('SAGA_STATE_CORRUPT', `Saga step ${key} was not found.`);
  return step;
}

function latestVerificationDigest(entry: { transitions: Array<{ verificationDigest?: string }> }): string | undefined {
  return [...entry.transitions].reverse().find((item) => item.verificationDigest)?.verificationDigest;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
function sha(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw corrupt(`${label} is invalid.`);
  return value;
}
function uuid(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new OperatorError('SAGA_INPUT_INVALID', `${label} must be a UUID.`);
  }
  return value.toLowerCase();
}
function boundedKey(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new OperatorError('SAGA_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function bounded(input: unknown, max: number, label: string): string {
  const value = String(input ?? '');
  if (value.length < 1 || value.length > max || value.includes('\0')) throw new OperatorError('SAGA_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function iso(input: unknown): string {
  const value = String(input ?? '');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw corrupt('Timestamp is invalid.');
  return value;
}
function integer(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('SAGA_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function corrupt(message: string): OperatorError {
  return new OperatorError('SAGA_STATE_CORRUPT', `Durable saga state is invalid. ${message}`);
}
