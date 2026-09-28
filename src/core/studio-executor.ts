import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import type { TeachModeStore, TeachWorkflowStep } from './studio-teach.ts';
import type { OperatorRuntime } from './runtime.ts';
import type { ActionRequest, ActionResult, PermissionProfile, SideEffectState } from './types.ts';
import { conservativeSideEffectState } from './side-effect.ts';
import type { ResourceLeaseStore } from './resource-leases.ts';
import { resourceKeysForAction } from './resource-identity.ts';
import { VerificationKernel, type VerificationCheck, type VerificationReceipt } from './verification-kernel.ts';

export type StudioRunState =
  | 'PENDING'
  | 'RUNNING'
  | 'BLOCKED'
  | 'FAILED'
  | 'CANCELLED'
  | 'AWAITING_VERIFICATION'
  | 'VERIFIED';

export type StudioStepState = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'NEEDS_RECONCILIATION' | 'SKIPPED';

export interface StudioRunStep {
  key: string;
  actionId: string;
  capability: string;
  risk: ActionRequest['risk'];
  target?: string;
  input: Record<string, unknown>;
  inputDigest: string;
  resourceKeys: string[];
  dependsOn: string[];
  state: StudioStepState;
  attempt: number;
  provider?: string;
  sideEffectState?: SideEffectState;
  evidenceDigest?: string;
  errorCode?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface StudioWorkflowRun {
  version: 1;
  id: string;
  workflowId: string;
  workflowDigest: string;
  scopeKey: string;
  parameterDigest: string;
  state: StudioRunState;
  steps: StudioRunStep[];
  verificationReceipt?: VerificationReceipt;
  createdAt: string;
  updatedAt: string;
}

interface StudioRunStateFile {
  version: 1;
  runs: StudioWorkflowRun[];
}

const MAX_RUNS = 2000;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const STORE_OPTIONS = {
  maxBytes: MAX_STATE_BYTES,
  errorCode: 'STUDIO_RUN_STATE_CORRUPT',
  invalidMessage: 'Studio workflow-run state is invalid.'
} as const;

type ExecuteAction = (action: ActionRequest, permissions: PermissionProfile, signal?: AbortSignal) => Promise<ActionResult>;

export class StudioWorkflowExecutor {
  #file: string;
  #teach: TeachModeStore;
  #runtime: OperatorRuntime;
  #leases: ResourceLeaseStore;
  #permissions: PermissionProfile;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, dependencies: {
    teach: TeachModeStore;
    runtime: OperatorRuntime;
    leases: ResourceLeaseStore;
    permissions: PermissionProfile;
    clock?: () => Date;
  }) {
    this.#file = path.join(path.resolve(stateDir), 'studio-runs.json');
    this.#teach = dependencies.teach;
    this.#runtime = dependencies.runtime;
    this.#leases = dependencies.leases;
    this.#permissions = structuredClone(dependencies.permissions);
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  async submit(workflowIdInput: string, values: Record<string, unknown>, runIdInput?: string): Promise<StudioWorkflowRun> {
    const workflow = await this.#teach.inspectWorkflow(workflowIdInput);
    const steps = await this.#teach.instantiate(workflow.id, values);
    const runId = runIdInput === undefined ? crypto.randomUUID() : uuid(runIdInput, 'runId');
    const parameterDigest = digest(values ?? {});
    return await this.#mutate((state, now) => {
      const existing = state.runs.find((item) => item.id === runId);
      if (existing) {
        if (existing.workflowId !== workflow.id || existing.workflowDigest !== workflow.digest || existing.parameterDigest !== parameterDigest) {
          throw new OperatorError('STUDIO_RUN_CONFLICT', 'runId is already bound to a different workflow execution contract.');
        }
        return existing;
      }
      if (state.runs.length >= MAX_RUNS) {
        const reclaim = state.runs.findIndex((item) => ['FAILED', 'CANCELLED', 'VERIFIED'].includes(item.state));
        if (reclaim < 0) throw new OperatorError('STUDIO_RUN_LIMIT', 'Studio workflow-run retention limit reached.');
        state.runs.splice(reclaim, 1);
      }
      const run: StudioWorkflowRun = {
        version: 1,
        id: runId,
        workflowId: workflow.id,
        workflowDigest: workflow.digest,
        scopeKey: workflow.scopeKey,
        parameterDigest,
        state: 'PENDING',
        steps: steps.map((step) => toRunStep(runId, step)),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      state.runs.push(run);
      return run;
    });
  }

  async execute(runIdInput: string, options: {
    signal?: AbortSignal;
    executeAction?: ExecuteAction;
    maxSteps?: number;
  } = {}): Promise<StudioWorkflowRun> {
    const runId = uuid(runIdInput, 'runId');
    const runLease = await this.#leases.acquire(`studio-run:${runId}:${crypto.randomUUID()}`, [`studio-run:${runId}`], 'exclusive');
    try {
      let run = await this.inspect(runId);
      if (run.state === 'CANCELLED' || run.state === 'VERIFIED') return run;
      if (run.state === 'FAILED') throw new OperatorError('STUDIO_RUN_TERMINAL', 'Failed Studio workflow run cannot execute again.');
      if (run.state === 'BLOCKED') throw new OperatorError('STUDIO_RUN_RECONCILIATION_REQUIRED', 'Studio workflow run is blocked on uncertain side effects.');
      if (run.state === 'AWAITING_VERIFICATION') return run;

      const maxSteps = integer(options.maxSteps ?? 20, 1, 50, 'maxSteps');
      let executedThisCall = 0;
      run = await this.#update(runId, (current) => { current.state = 'RUNNING'; });
      for (const step of run.steps) {
        if (step.state === 'PENDING' && executedThisCall >= maxSteps) {
          run = await this.#update(runId, (current) => { current.state = 'PENDING'; });
          return run;
        }
        if (options.signal?.aborted) {
          run = await this.#update(runId, (current) => {
            current.state = 'CANCELLED';
            const candidate = current.steps.find((item) => item.key === step.key);
            if (candidate && candidate.state === 'PENDING') candidate.state = 'SKIPPED';
          });
          return run;
        }
        if (step.state === 'SUCCEEDED') continue;
        if (step.state !== 'PENDING') {
          throw new OperatorError('STUDIO_RUN_STATE_CORRUPT', `Step ${step.key} is not safely executable from state ${step.state}.`);
        }
        const current = await this.inspect(runId);
        const freshStep = current.steps.find((item) => item.key === step.key)!;
        if (!freshStep.dependsOn.every((key) => current.steps.find((item) => item.key === key)?.state === 'SUCCEEDED')) {
          throw new OperatorError('STUDIO_DEPENDENCY_UNSATISFIED', `Dependencies for ${step.key} are not satisfied.`);
        }

        const action: ActionRequest = {
          id: freshStep.actionId,
          capability: freshStep.capability,
          risk: freshStep.risk,
          input: structuredClone(freshStep.input),
          provenance: { kind: 'trusted_policy', source: `studio-workflow:${current.workflowId}` },
          ...(freshStep.target ? { target: freshStep.target } : {}),
          taskId: current.id
        };
        const derivedResources = resourceKeysForAction(action);
        const resources = [...new Set([...freshStep.resourceKeys, ...derivedResources])].sort();
        const leaseMode = freshStep.risk === 'read' ? 'shared' as const : 'exclusive' as const;
        const stepLease = await this.#leases.acquire(`studio-step:${runId}:${freshStep.key}:${crypto.randomUUID()}`, resources, leaseMode);
        try {
          await this.#update(runId, (mutable) => {
            const record = requireStep(mutable, freshStep.key);
            record.state = 'RUNNING';
            record.attempt += 1;
            record.startedAt = this.#clock().toISOString();
            delete record.finishedAt;
            delete record.errorCode;
            delete record.provider;
            delete record.evidenceDigest;
            delete record.sideEffectState;
          });
          const execute = options.executeAction
            ?? ((candidate: ActionRequest, permissions: PermissionProfile, signal?: AbortSignal) => this.#runtime.execute(candidate, permissions, { signal, learningContext: `studio:${current.workflowId}` }));
          const result = await execute(action, this.#permissions, options.signal);
          const sideEffectState = conservativeSideEffectState(freshStep.risk, result);
          run = await this.#update(runId, (mutable) => {
            const record = requireStep(mutable, freshStep.key);
            record.provider = result.provider;
            record.sideEffectState = sideEffectState;
            record.evidenceDigest = digest(result.evidence);
            record.finishedAt = this.#clock().toISOString();
            if (result.ok) {
              record.state = 'SUCCEEDED';
              return;
            }
            record.errorCode = result.error?.code ?? 'STUDIO_STEP_FAILED';
            if (result.provider === 'policy' && result.error?.code === 'APPROVAL_REQUIRED') {
              record.state = 'PENDING';
              mutable.state = 'PENDING';
            } else if (sideEffectState === 'uncertain' && freshStep.risk !== 'read') {
              record.state = 'NEEDS_RECONCILIATION';
              mutable.state = 'BLOCKED';
            } else {
              record.state = 'FAILED';
              mutable.state = 'FAILED';
            }
          });
          executedThisCall += 1;
          if (!result.ok) return run;
        } finally {
          await stepLease.release();
        }
      }

      run = await this.#update(runId, (current) => {
        if (!current.steps.every((step) => step.state === 'SUCCEEDED')) {
          throw new OperatorError('STUDIO_RUN_STATE_CORRUPT', 'Studio workflow cannot await verification before every step succeeds.');
        }
        current.state = 'AWAITING_VERIFICATION';
      });
      return run;
    } finally {
      await runLease.release();
    }
  }

  async verificationContract(runIdInput: string): Promise<Record<string, unknown>> {
    const run = await this.inspect(runIdInput);
    return runVerificationContract(run);
  }

  async verify(runIdInput: string, checks: VerificationCheck[]): Promise<StudioWorkflowRun> {
    const runId = uuid(runIdInput, 'runId');
    return await this.#update(runId, (run) => {
      if (run.state === 'VERIFIED') return;
      if (run.state !== 'AWAITING_VERIFICATION') throw new OperatorError('STUDIO_RUN_NOT_READY_FOR_VERIFICATION', 'Studio workflow run must complete all execution steps before verification.');
      const receipt = new VerificationKernel().verify({
        subjectKind: 'studio-workflow-run',
        subjectId: run.id,
        contract: runVerificationContract(run),
        checks
      });
      run.verificationReceipt = receipt;
      run.state = receipt.verified ? 'VERIFIED' : 'FAILED';
    });
  }

  async reconcile(runIdInput: string, stepKeyInput: string, input: {
    resolution: 'completed' | 'retry' | 'failed';
    checks: VerificationCheck[];
  }): Promise<StudioWorkflowRun> {
    const runId = uuid(runIdInput, 'runId');
    const stepKey = bounded(stepKeyInput, 128, 'stepKey');
    return await this.#update(runId, (run) => {
      if (run.state !== 'BLOCKED') throw new OperatorError('STUDIO_RUN_NOT_BLOCKED', 'Studio run is not awaiting reconciliation.');
      const step = requireStep(run, stepKey);
      if (step.state !== 'NEEDS_RECONCILIATION') throw new OperatorError('STUDIO_STEP_NOT_UNCERTAIN', 'Studio step is not awaiting reconciliation.');
      const receipt = new VerificationKernel().verify({
        subjectKind: 'studio-step-reconciliation',
        subjectId: `${run.id}:${step.key}`,
        contract: reconciliationContract(run, step, input.resolution),
        checks: input.checks
      });
      if (!receipt.verified) throw new OperatorError('STUDIO_RECONCILIATION_UNVERIFIED', 'Reconciliation requires all independent checks to pass.');
      if (input.resolution === 'completed') {
        step.state = 'SUCCEEDED';
        step.sideEffectState = 'known';
        delete step.errorCode;
      } else if (input.resolution === 'retry') {
        step.state = 'PENDING';
        step.sideEffectState = 'none';
        delete step.errorCode;
        delete step.provider;
        delete step.evidenceDigest;
        delete step.startedAt;
        delete step.finishedAt;
      } else {
        step.state = 'FAILED';
        run.state = 'FAILED';
        return;
      }
      run.state = 'PENDING';
    });
  }

  async cancel(runIdInput: string): Promise<StudioWorkflowRun> {
    return await this.#update(uuid(runIdInput, 'runId'), (run) => {
      if (run.state === 'VERIFIED') throw new OperatorError('STUDIO_RUN_TERMINAL', 'Verified Studio workflow run cannot be cancelled.');
      if (run.state === 'RUNNING') throw new OperatorError('STUDIO_RUN_ACTIVE', 'Active Studio workflow run must be aborted through its execution signal before cancellation.');
      run.state = 'CANCELLED';
      for (const step of run.steps) if (step.state === 'PENDING') step.state = 'SKIPPED';
    });
  }

  async recoverInterrupted(): Promise<number> {
    let recovered = 0;
    await this.#mutate((state) => {
      for (const run of state.runs) {
        if (run.state !== 'RUNNING') continue;
        const active = run.steps.find((step) => step.state === 'RUNNING');
        if (!active) {
          run.state = 'PENDING';
          recovered += 1;
          continue;
        }
        if (active.risk === 'read') {
          active.state = 'PENDING';
          active.sideEffectState = 'none';
          delete active.startedAt;
          run.state = 'PENDING';
        } else {
          active.state = 'NEEDS_RECONCILIATION';
          active.sideEffectState = 'uncertain';
          active.errorCode = 'STUDIO_STEP_INTERRUPTED';
          active.finishedAt = this.#clock().toISOString();
          run.state = 'BLOCKED';
        }
        recovered += 1;
      }
    });
    return recovered;
  }

  async inspect(runIdInput: string): Promise<StudioWorkflowRun> {
    await this.#serial;
    const state = await this.#read();
    const run = state.runs.find((item) => item.id === uuid(runIdInput, 'runId'));
    if (!run) throw new OperatorError('STUDIO_RUN_NOT_FOUND', 'Studio workflow run was not found.');
    return structuredClone(run);
  }

  async list(limitInput = 100): Promise<StudioWorkflowRun[]> {
    await this.#serial;
    const limit = integer(limitInput, 1, 500, 'limit');
    return (await this.#read()).runs.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map((item) => structuredClone(item));
  }

  async #update(id: string, mutate: (run: StudioWorkflowRun) => void): Promise<StudioWorkflowRun> {
    return await this.#mutate((state, now) => {
      const run = state.runs.find((item) => item.id === id);
      if (!run) throw new OperatorError('STUDIO_RUN_NOT_FOUND', 'Studio workflow run was not found.');
      mutate(run);
      run.updatedAt = now.toISOString();
      return run;
    });
  }

  async #mutate<T>(fn: (state: StudioRunStateFile, now: Date) => T | Promise<T>): Promise<T> {
    let output!: T;
    const operation = this.#serial.then(async () => {
      const state = await this.#read();
      output = await fn(state, this.#clock());
      validateState(state);
      await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
    });
    this.#serial = operation.then(() => undefined, () => undefined);
    await operation;
    return structuredClone(output);
  }

  async #read(): Promise<StudioRunStateFile> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, runs: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('STUDIO_RUN_STATE_CORRUPT', 'Studio workflow-run state could not be read.');
    }
  }
}

function toRunStep(runId: string, step: TeachWorkflowStep): StudioRunStep {
  return {
    key: step.key,
    actionId: `studio:${runId}:${step.key}`,
    capability: step.capability,
    risk: step.risk,
    ...(step.target ? { target: step.target } : {}),
    input: structuredClone(step.inputTemplate),
    inputDigest: digest(step.inputTemplate),
    resourceKeys: [...step.resourceKeys],
    dependsOn: [...step.dependsOn],
    state: 'PENDING',
    attempt: 0
  };
}

function requireStep(run: StudioWorkflowRun, key: string): StudioRunStep {
  const step = run.steps.find((item) => item.key === key);
  if (!step) throw new OperatorError('STUDIO_STEP_NOT_FOUND', `Studio workflow step ${key} was not found.`);
  return step;
}

function runVerificationContract(run: StudioWorkflowRun): Record<string, unknown> {
  return {
    version: 1,
    runId: run.id,
    workflowId: run.workflowId,
    workflowDigest: run.workflowDigest,
    scopeKey: run.scopeKey,
    parameterDigest: run.parameterDigest,
    steps: run.steps.map((step) => ({
      key: step.key,
      actionId: step.actionId,
      capability: step.capability,
      risk: step.risk,
      inputDigest: step.inputDigest,
      resourceKeys: step.resourceKeys,
      provider: step.provider ?? null,
      sideEffectState: step.sideEffectState ?? null,
      evidenceDigest: step.evidenceDigest ?? null,
      state: step.state
    }))
  };
}

function reconciliationContract(run: StudioWorkflowRun, step: StudioRunStep, resolution: string): Record<string, unknown> {
  return {
    version: 1,
    runId: run.id,
    workflowId: run.workflowId,
    workflowDigest: run.workflowDigest,
    stepKey: step.key,
    actionId: step.actionId,
    capability: step.capability,
    risk: step.risk,
    inputDigest: step.inputDigest,
    resolution
  };
}

function validateState(input: unknown): StudioRunStateFile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const state = input as StudioRunStateFile;
  if (state.version !== 1 || !Array.isArray(state.runs) || state.runs.length > MAX_RUNS) throw corrupt('State shape is invalid.');
  const ids = new Set<string>();
  for (const run of state.runs) {
    uuid(run.id, 'run.id');
    if (ids.has(run.id)) throw corrupt('Run IDs must be unique.');
    ids.add(run.id);
    uuid(run.workflowId, 'run.workflowId');
    sha(run.workflowDigest, 'run.workflowDigest');
    sha(run.parameterDigest, 'run.parameterDigest');
    bounded(run.scopeKey, 512, 'run.scopeKey');
    if (!['PENDING','RUNNING','BLOCKED','FAILED','CANCELLED','AWAITING_VERIFICATION','VERIFIED'].includes(run.state)) throw corrupt('Run state is invalid.');
    if (!Array.isArray(run.steps) || run.steps.length < 1 || run.steps.length > 200) throw corrupt('Run steps are invalid.');
    const keys = new Set<string>();
    for (const step of run.steps) {
      bounded(step.key, 128, 'step.key');
      if (keys.has(step.key)) throw corrupt('Run step keys must be unique.');
      keys.add(step.key);
      bounded(step.actionId, 256, 'step.actionId');
      bounded(step.capability, 256, 'step.capability');
      sha(step.inputDigest, 'step.inputDigest');
      if (digest(step.input) !== step.inputDigest) throw corrupt('Run step input digest mismatch.');
      if (!Array.isArray(step.resourceKeys) || !Array.isArray(step.dependsOn) || !Number.isSafeInteger(step.attempt) || step.attempt < 0 || step.attempt > 1000) throw corrupt('Run step metadata is invalid.');
      if (!['PENDING','RUNNING','SUCCEEDED','FAILED','NEEDS_RECONCILIATION','SKIPPED'].includes(step.state)) throw corrupt('Run step state is invalid.');
      if (step.sideEffectState && !['none','known','uncertain'].includes(step.sideEffectState)) throw corrupt('Run step side-effect state is invalid.');
      if (step.evidenceDigest) sha(step.evidenceDigest, 'step.evidenceDigest');
    }
    if (run.verificationReceipt) {
      const receipt = run.verificationReceipt;
      if (receipt.subjectKind !== 'studio-workflow-run' || receipt.subjectId !== run.id) throw corrupt('Run verification receipt is bound to a different subject.');
      const expected = new VerificationKernel().verify({
        subjectKind: 'studio-workflow-run',
        subjectId: run.id,
        contract: runVerificationContract(run),
        checks: receipt.checks
      });
      if (expected.digest !== receipt.digest || expected.contractDigest !== receipt.contractDigest || expected.verified !== receipt.verified) {
        throw corrupt('Run verification receipt does not match the persisted execution contract.');
      }
      if (run.state === 'VERIFIED' && !receipt.verified) throw corrupt('Verified Studio run requires a passing verification receipt.');
    } else if (run.state === 'VERIFIED') {
      throw corrupt('Verified Studio run is missing its verification receipt.');
    }
    iso(run.createdAt, 'run.createdAt');
    iso(run.updatedAt, 'run.updatedAt');
  }
  return state;
}

function digest(value: unknown): string { return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function sha(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw corrupt(`${label} must be SHA-256.`);
  return value;
}
function uuid(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new OperatorError('STUDIO_RUN_INPUT_INVALID', `${label} must be a UUID.`);
  return value;
}
function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) throw new OperatorError('STUDIO_RUN_INPUT_INVALID', `${label} is invalid.`);
  return input;
}
function integer(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('STUDIO_RUN_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function iso(input: unknown, label: string): string {
  const value = String(input ?? '');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw corrupt(`${label} is invalid.`);
  return value;
}
function corrupt(message: string): OperatorError {
  return new OperatorError('STUDIO_RUN_STATE_CORRUPT', `Studio workflow-run state is invalid. ${message}`);
}
