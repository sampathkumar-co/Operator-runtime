import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { OperatorError } from './errors.ts';
import { VerificationKernel, type VerificationCheck, type VerificationReceipt } from './verification-kernel.ts';
import type { ActionRequest, ActionResult, ActionRisk } from './types.ts';

export type TeachSessionState = 'RECORDING' | 'STOPPED' | 'COMPILED' | 'CANCELLED';

export interface TeachCapturedStep {
  id: string;
  seq: number;
  capability: string;
  risk: ActionRisk;
  target?: string;
  inputTemplate: Record<string, unknown>;
  inputDigest: string;
  resourceKeys: string[];
  provider: string;
  evidenceDigest: string;
  capturedAt: string;
}

export interface TeachSession {
  version: 1;
  id: string;
  title: string;
  objective: string;
  scopeKey: string;
  state: TeachSessionState;
  steps: TeachCapturedStep[];
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
  compiledWorkflowId?: string;
}

export interface TeachWorkflowParameter {
  name: string;
  stepId: string;
  jsonPointer: string;
  required: boolean;
}

export interface TeachWorkflowStep {
  key: string;
  capability: string;
  risk: ActionRisk;
  target?: string;
  inputTemplate: Record<string, unknown>;
  resourceKeys: string[];
  dependsOn: string[];
}

export interface TeachWorkflow {
  version: 1;
  id: string;
  sourceSessionId: string;
  title: string;
  objective: string;
  scopeKey: string;
  steps: TeachWorkflowStep[];
  parameters: TeachWorkflowParameter[];
  verificationDigest: string;
  verificationContractDigest: string;
  digest: string;
  createdAt: string;
}

interface TeachState {
  version: 1;
  sessions: TeachSession[];
  workflows: TeachWorkflow[];
}

const MAX_SESSIONS = 1000;
const MAX_WORKFLOWS = 1000;
const MAX_STEPS = 200;
const MAX_RESOURCE_KEYS = 500;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 48 * 1024 * 1024;
const SECRET_KEY = /(pass(word)?|secret|token|authorization|cookie|credential|private.?key|api.?key|session.?key|refresh.?token)/i;
const STORE_OPTIONS = {
  maxBytes: MAX_STATE_BYTES,
  errorCode: 'TEACH_STATE_CORRUPT',
  invalidMessage: 'Teach/Studio state is invalid.'
} as const;

export class TeachModeStore {
  #file: string;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'studio-teach.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async start(input: { sessionId?: string; title: string; objective: string; scopeKey: string }): Promise<TeachSession> {
    return await this.#mutate((state, now) => {
      const id = input.sessionId ? uuid(input.sessionId, 'sessionId') : crypto.randomUUID();
      const existing = state.sessions.find((item) => item.id === id);
      const normalized = {
        title: bounded(input.title, 4096, 'title'),
        objective: bounded(input.objective, 16_384, 'objective'),
        scopeKey: contextKey(input.scopeKey, 'scopeKey')
      };
      if (existing) {
        if (existing.title !== normalized.title || existing.objective !== normalized.objective || existing.scopeKey !== normalized.scopeKey) {
          throw new OperatorError('TEACH_SESSION_CONFLICT', 'sessionId is already bound to a different teaching contract.');
        }
        return existing;
      }
      if (state.sessions.length >= MAX_SESSIONS) reclaimTerminal(state.sessions, MAX_SESSIONS, 'TEACH_SESSION_LIMIT');
      const session: TeachSession = {
        version: 1,
        id,
        ...normalized,
        state: 'RECORDING',
        steps: [],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      state.sessions.push(session);
      return session;
    });
  }

  async record(sessionIdInput: string, input: {
    action: ActionRequest;
    result: ActionResult;
    resourceKeys?: string[];
  }): Promise<TeachSession> {
    return await this.#mutate((state, now) => {
      const session = requireSession(state, sessionIdInput);
      if (session.state !== 'RECORDING') throw new OperatorError('TEACH_SESSION_NOT_RECORDING', 'Only recording sessions can accept demonstrated actions.');
      if (!input.result.ok) throw new OperatorError('TEACH_ACTION_UNSUCCESSFUL', 'Failed actions are not eligible for workflow teaching.');
      if (input.action.capability !== input.result.capability) throw new OperatorError('TEACH_ACTION_MISMATCH', 'Action/result capability mismatch.');
      if (session.steps.length >= MAX_STEPS) throw new OperatorError('TEACH_STEP_LIMIT', `Teach sessions are limited to ${MAX_STEPS} successful semantic steps.`);

      const safeInput = secretFreeClone(input.action.input, 'action.input');
      const resourceKeys = uniqueStrings(input.resourceKeys ?? [], MAX_RESOURCE_KEYS, 1024, 'resourceKeys').sort();
      const seq = session.steps.length + 1;
      const step: TeachCapturedStep = {
        id: stableStepId(session.id, seq),
        seq,
        capability: bounded(input.action.capability, 256, 'capability'),
        risk: validRisk(input.action.risk),
        ...(input.action.target ? { target: bounded(input.action.target, 4096, 'target') } : {}),
        inputTemplate: safeInput,
        inputDigest: digest(safeInput),
        resourceKeys,
        provider: bounded(input.result.provider, 256, 'provider'),
        evidenceDigest: digest(input.result.evidence),
        capturedAt: now.toISOString()
      };
      session.steps.push(step);
      session.updatedAt = now.toISOString();
      return session;
    });
  }

  async stop(sessionIdInput: string): Promise<TeachSession> {
    return await this.#mutate((state, now) => {
      const session = requireSession(state, sessionIdInput);
      if (session.state === 'CANCELLED' || session.state === 'COMPILED') throw new OperatorError('TEACH_SESSION_TERMINAL', 'Terminal teaching session cannot be stopped.');
      if (session.state === 'STOPPED') return session;
      if (session.steps.length < 1) throw new OperatorError('TEACH_EMPTY_SESSION', 'At least one successful demonstrated action is required.');
      session.state = 'STOPPED';
      session.stoppedAt = now.toISOString();
      session.updatedAt = now.toISOString();
      return session;
    });
  }

  async cancel(sessionIdInput: string): Promise<TeachSession> {
    return await this.#mutate((state, now) => {
      const session = requireSession(state, sessionIdInput);
      if (session.state === 'COMPILED') throw new OperatorError('TEACH_SESSION_TERMINAL', 'Compiled teaching session cannot be cancelled.');
      session.state = 'CANCELLED';
      session.updatedAt = now.toISOString();
      return session;
    });
  }

  async verify(sessionIdInput: string, checks: VerificationCheck[]): Promise<VerificationReceipt> {
    await this.#serial;
    const session = requireSession(await this.#read(), sessionIdInput);
    if (session.state !== 'STOPPED') throw new OperatorError('TEACH_SESSION_NOT_STOPPED', 'Teaching session must be stopped before verification.');
    return new VerificationKernel().verify({
      subjectKind: 'teach-session',
      subjectId: session.id,
      contract: teachVerificationContract(session),
      checks
    });
  }

  async compile(sessionIdInput: string, input: {
    verificationReceipt: VerificationReceipt;
    parameters?: TeachWorkflowParameter[];
  }): Promise<TeachWorkflow> {
    return await this.#mutate((state, now) => {
      const session = requireSession(state, sessionIdInput);
      if (session.state === 'COMPILED' && session.compiledWorkflowId) return requireWorkflow(state, session.compiledWorkflowId);
      if (session.state !== 'STOPPED') throw new OperatorError('TEACH_SESSION_NOT_STOPPED', 'Teaching session must be stopped before compilation.');
      const verification = validateTeachVerificationReceipt(session, input.verificationReceipt);
      const verificationDigest = verification.digest;
      const verificationContractDigest = verification.contractDigest;
      const parameters = normalizeParameters(input.parameters ?? [], session);
      const steps: TeachWorkflowStep[] = session.steps.map((step, index) => ({
        key: `step-${String(index + 1).padStart(3, '0')}`,
        capability: step.capability,
        risk: step.risk,
        ...(step.target ? { target: step.target } : {}),
        inputTemplate: structuredClone(step.inputTemplate),
        resourceKeys: [...step.resourceKeys],
        dependsOn: index === 0 ? [] : [`step-${String(index).padStart(3, '0')}`]
      }));
      const workflowCore = {
        version: 1 as const,
        sourceSessionId: session.id,
        title: session.title,
        objective: session.objective,
        scopeKey: session.scopeKey,
        steps,
        parameters,
        verificationDigest,
        verificationContractDigest
      };
      const workflow: TeachWorkflow = {
        ...workflowCore,
        id: crypto.randomUUID(),
        digest: digest(workflowCore),
        createdAt: now.toISOString()
      };
      if (state.workflows.length >= MAX_WORKFLOWS) throw new OperatorError('TEACH_WORKFLOW_LIMIT', 'Teach/Studio workflow retention limit reached.');
      state.workflows.push(workflow);
      session.state = 'COMPILED';
      session.compiledWorkflowId = workflow.id;
      session.updatedAt = now.toISOString();
      return workflow;
    });
  }

  async inspectSession(sessionIdInput: string): Promise<TeachSession> {
    await this.#serial;
    return structuredClone(requireSession(await this.#read(), sessionIdInput));
  }

  async inspectWorkflow(workflowIdInput: string): Promise<TeachWorkflow> {
    await this.#serial;
    return structuredClone(requireWorkflow(await this.#read(), workflowIdInput));
  }

  async instantiate(workflowIdInput: string, values: Record<string, unknown>): Promise<TeachWorkflowStep[]> {
    await this.#serial;
    const workflow = requireWorkflow(await this.#read(), workflowIdInput);
    const supplied = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
    const expected = new Set(workflow.parameters.map((parameter) => parameter.name));
    for (const key of Object.keys(supplied)) if (!expected.has(key)) throw new OperatorError('TEACH_PARAMETER_UNKNOWN', `Unknown workflow parameter ${key}.`);
    const steps = structuredClone(workflow.steps);
    for (const parameter of workflow.parameters) {
      if (!(parameter.name in supplied)) {
        if (parameter.required) throw new OperatorError('TEACH_PARAMETER_REQUIRED', `Workflow parameter ${parameter.name} is required.`);
        continue;
      }
      const stepIndex = workflow.steps.findIndex((step) => stableStepId(workflow.sourceSessionId, Number(step.key.slice(5))) === parameter.stepId);
      if (stepIndex < 0) throw new OperatorError('TEACH_STATE_CORRUPT', 'Workflow parameter references an unknown source step.');
      setJsonPointer(steps[stepIndex]!.inputTemplate, parameter.jsonPointer, secretFreeClone(supplied[parameter.name], `parameter.${parameter.name}`));
    }
    return steps;
  }

  async #mutate<T>(fn: (state: TeachState, now: Date) => T | Promise<T>): Promise<T> {
    let output!: T;
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      output = await fn(state, this.#clock());
      validateState(state);
      await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return structuredClone(output);
  }

  async #read(): Promise<TeachState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: [], workflows: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('TEACH_STATE_CORRUPT', 'Teach/Studio state could not be read.');
    }
  }
}

function teachVerificationContract(session: TeachSession): Record<string, unknown> {
  return {
    version: 1,
    sessionId: session.id,
    title: session.title,
    objective: session.objective,
    scopeKey: session.scopeKey,
    steps: session.steps.map((step) => ({
      id: step.id,
      seq: step.seq,
      capability: step.capability,
      risk: step.risk,
      target: step.target ?? null,
      inputDigest: step.inputDigest,
      resourceKeys: [...step.resourceKeys],
      provider: step.provider,
      evidenceDigest: step.evidenceDigest
    }))
  };
}

function validateTeachVerificationReceipt(session: TeachSession, receipt: VerificationReceipt): VerificationReceipt {
  if (!receipt || typeof receipt !== 'object') throw new OperatorError('TEACH_VERIFICATION_INVALID', 'A verification receipt is required.');
  if (receipt.subjectKind !== 'teach-session' || receipt.subjectId !== session.id) {
    throw new OperatorError('TEACH_VERIFICATION_INVALID', 'Verification receipt is bound to a different teaching session.');
  }
  const expected = new VerificationKernel().verify({
    subjectKind: 'teach-session',
    subjectId: session.id,
    contract: teachVerificationContract(session),
    checks: receipt.checks
  });
  if (expected.digest !== receipt.digest || expected.contractDigest !== receipt.contractDigest) {
    throw new OperatorError('TEACH_VERIFICATION_INVALID', 'Verification receipt does not match the captured demonstration contract.');
  }
  if (!receipt.verified || !expected.verified) {
    throw new OperatorError('TEACH_VERIFICATION_REQUIRED', 'Teaching workflow cannot compile until all verification checks pass.');
  }
  return expected;
}

function normalizeParameters(input: TeachWorkflowParameter[], session: TeachSession): TeachWorkflowParameter[] {
  if (!Array.isArray(input) || input.length > 1000) throw new OperatorError('TEACH_PARAMETER_INVALID', 'Workflow parameters are invalid.');
  const names = new Set<string>();
  return input.map((parameter, index) => {
    const name = bounded(parameter.name, 128, `parameters[${index}].name`);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name) || names.has(name)) throw new OperatorError('TEACH_PARAMETER_INVALID', 'Workflow parameter names must be unique identifiers.');
    names.add(name);
    const stepId = uuid(parameter.stepId, `parameters[${index}].stepId`);
    const step = session.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw new OperatorError('TEACH_PARAMETER_INVALID', 'Workflow parameter references an unknown demonstrated step.');
    const jsonPointer = validJsonPointer(parameter.jsonPointer);
    assertPointerExists(step.inputTemplate, jsonPointer);
    return { name, stepId, jsonPointer, required: parameter.required !== false };
  });
}

function secretFreeClone<T>(value: T, label: string): T {
  let bytes: string;
  try { bytes = canonicalJson(value); } catch { throw new OperatorError('TEACH_INPUT_INVALID', `${label} must be JSON serializable.`); }
  if (Buffer.byteLength(bytes, 'utf8') > MAX_JSON_BYTES) throw new OperatorError('TEACH_INPUT_INVALID', `${label} is too large.`);
  const walk = (current: unknown, trail: string): void => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${trail}/${index}`));
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) throw new OperatorError('TEACH_SECRET_REJECTED', `Secret-bearing field ${trail}/${key} cannot be captured by Teach Mode.`);
      walk(child, `${trail}/${key}`);
    }
  };
  const clone = JSON.parse(bytes) as T;
  walk(clone, label);
  return clone;
}

function setJsonPointer(root: Record<string, unknown>, pointer: string, value: unknown): void {
  const parts = pointerParts(pointer);
  if (parts.length < 1) throw new OperatorError('TEACH_PARAMETER_INVALID', 'Root replacement is not supported.');
  let current: any = root;
  for (const part of parts.slice(0, -1)) {
    if (current === null || typeof current !== 'object' || !(part in current)) throw new OperatorError('TEACH_PARAMETER_INVALID', 'Workflow parameter path no longer exists.');
    current = current[part];
  }
  const leaf = parts.at(-1)!;
  if (current === null || typeof current !== 'object' || !(leaf in current)) throw new OperatorError('TEACH_PARAMETER_INVALID', 'Workflow parameter path no longer exists.');
  current[leaf] = value;
}

function assertPointerExists(root: Record<string, unknown>, pointer: string): void {
  const parts = pointerParts(pointer);
  if (parts.length < 1) throw new OperatorError('TEACH_PARAMETER_INVALID', 'Root parameterization is not supported.');
  let current: any = root;
  for (const part of parts) {
    if (current === null || typeof current !== 'object' || !(part in current)) throw new OperatorError('TEACH_PARAMETER_INVALID', `JSON pointer ${pointer} does not exist in the demonstrated input.`);
    current = current[part];
  }
}

function pointerParts(pointer: string): string[] {
  return pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function validJsonPointer(input: unknown): string {
  const value = bounded(input, 1024, 'jsonPointer');
  if (!value.startsWith('/') || /~(?![01])/g.test(value)) throw new OperatorError('TEACH_PARAMETER_INVALID', 'jsonPointer must be an RFC6901-style pointer.');
  return value;
}

function requireSession(state: TeachState, idInput: string): TeachSession {
  const id = uuid(idInput, 'sessionId');
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new OperatorError('TEACH_SESSION_NOT_FOUND', 'Teaching session was not found.');
  return session;
}

function requireWorkflow(state: TeachState, idInput: string): TeachWorkflow {
  const id = uuid(idInput, 'workflowId');
  const workflow = state.workflows.find((item) => item.id === id);
  if (!workflow) throw new OperatorError('TEACH_WORKFLOW_NOT_FOUND', 'Compiled workflow was not found.');
  return workflow;
}

function validateState(input: unknown): TeachState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('TEACH_STATE_CORRUPT', 'Teach state must be an object.');
  const state = input as TeachState;
  if (state.version !== 1 || !Array.isArray(state.sessions) || !Array.isArray(state.workflows) || state.sessions.length > MAX_SESSIONS || state.workflows.length > MAX_WORKFLOWS) {
    throw new OperatorError('TEACH_STATE_CORRUPT', 'Teach state shape is invalid.');
  }
  for (const session of state.sessions) {
    uuid(session.id, 'session.id');
    bounded(session.title, 4096, 'session.title');
    bounded(session.objective, 16_384, 'session.objective');
    contextKey(session.scopeKey, 'session.scopeKey');
    if (!['RECORDING', 'STOPPED', 'COMPILED', 'CANCELLED'].includes(session.state) || !Array.isArray(session.steps) || session.steps.length > MAX_STEPS) throw new OperatorError('TEACH_STATE_CORRUPT', 'Teach session state is invalid.');
    session.steps.forEach((step, index) => {
      uuid(step.id, 'step.id');
      if (step.seq !== index + 1) throw new OperatorError('TEACH_STATE_CORRUPT', 'Teach step sequence is invalid.');
      validRisk(step.risk); sha(step.inputDigest, 'inputDigest'); sha(step.evidenceDigest, 'evidenceDigest');
      secretFreeClone(step.inputTemplate, 'stored step input');
    });
  }
  for (const workflow of state.workflows) {
    uuid(workflow.id, 'workflow.id'); uuid(workflow.sourceSessionId, 'workflow.sourceSessionId');
    sha(workflow.verificationDigest, 'workflow.verificationDigest'); sha(workflow.verificationContractDigest, 'workflow.verificationContractDigest'); sha(workflow.digest, 'workflow.digest');
  }
  return state;
}

function reclaimTerminal<T extends { state?: string }>(items: T[], max: number, code: string): void {
  const index = items.findIndex((item) => item.state && ['COMPILED', 'CANCELLED'].includes(item.state));
  if (index < 0) throw new OperatorError(code, 'Teach/Studio retention limit reached.');
  items.splice(index, 1);
  if (items.length >= max) throw new OperatorError(code, 'Teach/Studio retention limit reached.');
}

function stableStepId(sessionId: string, seq: number): string {
  const bytes = Buffer.from(crypto.createHash('sha256').update(sessionId).update('\0').update(String(seq)).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function digest(value: unknown): string { return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function sha(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OperatorError('TEACH_INPUT_INVALID', `${label} must be SHA-256.`);
  return value;
}
function validRisk(input: unknown): ActionRisk {
  const value = String(input ?? '') as ActionRisk;
  if (!['read', 'write', 'external', 'system', 'destructive'].includes(value)) throw new OperatorError('TEACH_INPUT_INVALID', 'risk is invalid.');
  return value;
}
function contextKey(input: unknown, label: string): string {
  const value = bounded(input, 512, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/.test(value)) throw new OperatorError('TEACH_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) throw new OperatorError('TEACH_INPUT_INVALID', `${label} is invalid.`);
  return input;
}
function uniqueStrings(input: unknown, max: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > max) throw new OperatorError('TEACH_INPUT_INVALID', `${label} is invalid.`);
  const values = input.map((item, index) => bounded(item, maxLength, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new OperatorError('TEACH_INPUT_INVALID', `${label} contains duplicates.`);
  return values;
}
function uuid(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new OperatorError('TEACH_INPUT_INVALID', `${label} must be a UUID.`);
  return value;
}
