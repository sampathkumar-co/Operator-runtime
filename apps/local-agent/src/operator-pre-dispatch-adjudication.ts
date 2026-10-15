import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '../../../src/core/action-identity.ts';
import { readDurableStateText, writeDurableStateText } from '../../../src/core/durable-state.ts';
import { withDurableStateLock } from '../../../src/core/durable-state-lock.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { ActionTransitionJournal } from '../../../src/core/action-transition-journal.ts';
import { observeProcessInstance } from '../../../src/core/process-instance.ts';
import { LocalActionExecutionStore } from './action-execution-store.ts';

const MAX_BYTES = 256 * 1024;
const MAX_EVENTS = 256;
const ERROR_CODE = 'OPERATOR_RECOVERY_LEDGER_INVALID';
const STORE = { maxBytes: MAX_BYTES, errorCode: ERROR_CODE, invalidMessage: 'Operator recovery audit ledger is corrupt.' } as const;
const hexDigest = (o: unknown) => crypto.createHash('sha256').update(canonicalJson(o)).digest('hex');
const validHash = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const denied = (reason: string) => new OperatorError('OPERATOR_RECOVERY_DENIED', reason, { retryable: false });

type DeviceSigner = Pick<DeviceIdentityStore, 'loadExisting' | 'sign' | 'verify'>;
type SignedDecision = {
  version: 1; epoch: number; actionId: string; actionDigest: string;
  receiptAuthorityHash: string; receiptOwnerId: string; receiptOwnerProcessDigest?: string; caseDigest: string;
  journalGeneration: number; transitionsDigest: string; deviceId: string;
  deviceFingerprint: string; previousDigest: string; adjudicatedAt: string;
  operatorAttestation: string;
  signature: string;
};
type Ledger = { version: 1; decisions: SignedDecision[] };
export type OperatorRecoveryCandidate = {
  actionId: string; actionDigest: string; receiptAuthorityHash: string;
  receiptOwnerId: string; receiptOwnerProcessDigest?: string; journalGeneration: number; transitionsDigest: string;
  recoveryEpoch: number; deviceId: string; deviceFingerprint: string;
  caseDigest: string;
};

/** Local-machine signed operator action, intentionally not exposed by the relay or MCP API. */
export class OperatorPreDispatchAdjudicator {
  #file: string;
  #journal: ActionTransitionJournal;
  #receipts: LocalActionExecutionStore;
  #signer: DeviceSigner;
  #clock: () => Date;

  constructor(stateDir: string, options: {
    signer?: DeviceSigner; clock?: () => Date;
  } = {}) {
    const root = path.resolve(stateDir);
    this.#file = path.join(root, 'operator-pre-dispatch-adjudications.json');
    this.#journal = new ActionTransitionJournal(root);
    this.#receipts = new LocalActionExecutionStore(root);
    this.#signer = options.signer ?? new DeviceIdentityStore(root);
    this.#clock = options.clock ?? (() => new Date());
  }

  async inspect(actionId: string): Promise<OperatorRecoveryCandidate> {
    const device = await this.#signer.loadExisting();
    if (!device) throw denied('Existing local device identity is required; creating a new signer is forbidden.');
    const ledger = await this.#readVerifiedLedger();
    const existing = ledger.decisions.find(d => d.actionId === actionId);
    if (existing) throw denied('This action already has a signed operator adjudication. Review the retained audit decision.');
    return await this.#candidate(actionId, ledger.decisions.length + 1, device);
  }

  async adjudicate(input: { actionId: string; caseDigest: string; confirmation: string; ownerAttestation: string }): Promise<{
    actionId: string; state: 'INTERRUPTED'; epoch: number; caseDigest: string;
  }> {
    if (!validHash(input.caseDigest) || input.confirmation !==
        'AUTHORIZE-NO-REPLAY:' + input.caseDigest ||
        input.ownerAttestation !== 'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED') {
      throw denied('Exact operator review challenge and explicit no-replay confirmation are required.');
    }
    const device = await this.#signer.loadExisting();
    if (!device) throw denied('Existing local device identity is required.');
    let decision!: SignedDecision;
    await withDurableStateLock(this.#file, async () => {
      const ledger = await this.#readVerifiedLedger();
      const prior = ledger.decisions.find(d => d.actionId === input.actionId);
      if (prior) {
        if (prior.caseDigest !== input.caseDigest) throw denied('Operator recovery identity already adjudicated under another case.');
        decision = prior;
        return;
      }
      if (ledger.decisions.length >= MAX_EVENTS) throw denied('Recovery adjudication ledger is full; never discard signed history.');
      const candidate = await this.#candidate(input.actionId, ledger.decisions.length + 1, device);
      if (candidate.caseDigest !== input.caseDigest) {
        throw denied('Review challenge changed; retry inspection rather than authorizing stale state.');
      }
      const unsigned = {
        version: 1 as const, epoch: candidate.recoveryEpoch,
        actionId: candidate.actionId, actionDigest: candidate.actionDigest,
        receiptAuthorityHash: candidate.receiptAuthorityHash,
        receiptOwnerId: candidate.receiptOwnerId,
        ...(candidate.receiptOwnerProcessDigest ? { receiptOwnerProcessDigest: candidate.receiptOwnerProcessDigest } : {}),
        caseDigest: candidate.caseDigest,
        journalGeneration: candidate.journalGeneration,
        transitionsDigest: candidate.transitionsDigest, deviceId: device.deviceId,
        deviceFingerprint: device.fingerprint,
        previousDigest: ledger.decisions.length ? hexDigest(ledger.decisions.at(-1)) : '0'.repeat(64),
        adjudicatedAt: this.#clock().toISOString(),
        operatorAttestation: input.ownerAttestation
      };
      decision = { ...unsigned, signature: await this.#signer.sign(Buffer.from(canonicalJson(unsigned))) };
      ledger.decisions.push(decision);
      await writeDurableStateText(this.#file, JSON.stringify(ledger), STORE);
    });

    // The signed operator intent is durable BEFORE attempting the journal
    // fence. The journal independently locks provider dispatch and refuses
    // every uncertain or previously dispatched history.
    const current = await this.#journal.inspect(decision.actionId);
    if (current.state !== 'INTERRUPTED') {
      await this.#journal.interruptOperatorReviewedPolicyDeferral({
        actionId: decision.actionId, actionDigest: decision.actionDigest,
        generation: decision.journalGeneration, transitionsDigest: decision.transitionsDigest
      });
    } else {
      const policyDeferralFence = current.risk === 'external' && current.transitions.length === 3
        && current.transitions[0]?.state === 'PREPARED'
        && current.transitions[1]?.state === 'DEFERRED' && current.transitions[1]?.provider === 'policy'
        && current.transitions[2]?.state === 'INTERRUPTED';
      const preparedWriteFence = (current.risk === 'write' || current.risk === 'external' || current.risk === 'destructive')
        && current.transitions.length === 2
        && current.transitions[0]?.state === 'PREPARED'
        && current.transitions[1]?.state === 'INTERRUPTED';
      if (current.actionDigest !== decision.actionDigest || current.generation !== decision.journalGeneration
          || (!policyDeferralFence && !preparedWriteFence)) {
        throw denied('Existing terminal fence does not match the signed recovery decision.');
      }
    }
    return { actionId: decision.actionId, state: 'INTERRUPTED', epoch: decision.epoch, caseDigest: decision.caseDigest };
  }

  async #candidate(actionId: string, recoveryEpoch: number, device: NonNullable<Awaited<ReturnType<DeviceSigner['loadExisting']>>>): Promise<OperatorRecoveryCandidate> {
    const receipt = await this.#receipts.inspectOperatorReceipt(actionId);
    const journal = await this.#journal.inspect(actionId);
    // Original-device operator recovery supports the older UUID-only class
    // and strictly validated Windows process identities. Windows filetime is
    // NOT a transferable host proof: local operator attestation and the
    // existing device signer remain mandatory. Refuse a live/unknown owner.
    const originalPolicyDeferral = receipt?.risk === 'external' && journal.risk === 'external'
      && journal.state === 'DEFERRED' && journal.transitions.length === 2
      && journal.transitions[0]?.state === 'PREPARED'
      && journal.transitions[1]?.state === 'DEFERRED'
      && journal.transitions[1]?.provider === 'policy' && validHash(journal.transitions[1]?.resultDigest);
    // Any original PREPARED mutation (write/external/destructive) requires
    // an exact exited Windows process and a signed local human attestation.
    // Unbound legacy mutation receipts remain unreviewable; never infer dispatch
    // absence from their journal alone.
    const originalPreparedMutation = (receipt?.risk === 'write' || receipt?.risk === 'external' || receipt?.risk === 'destructive')
      && journal.risk === receipt.risk
      && journal.state === 'PREPARED' && journal.transitions.length === 1
      && journal.transitions[0]?.state === 'PREPARED' && receipt.ownerProcess !== undefined;
    if (!receipt || receipt.status !== 'processing' || !receipt.ownerId
        || receipt.actionHash !== journal.actionDigest || !validHash(receipt.authorityHash)
        || journal.generation !== 1 || (!originalPolicyDeferral && !originalPreparedMutation)) {
      throw denied('This action is not an exact original never-dispatched recovery candidate.');
    }
    if (receipt.ownerProcess !== undefined) {
      const owner = receipt.ownerProcess;
      if (process.platform !== 'win32' || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
          !/^windows-filetime:[0-9]{15,20}$/.test(owner.started)) {
        throw denied('Process-bound recovery requires the exact original Windows process identity.');
      }
      const observation = await observeProcessInstance(owner.pid);
      // Never terminate a process here. Only a definite dead PID (on the
      // operator-attested original host) permits a signed no-replay decision.
      if (observation.status !== 'dead') {
        throw denied('Original Windows owner is live or cannot be proven stopped; no recovery authorized.');
      }
    }
    const base = {
      actionId, actionDigest: journal.actionDigest,
      receiptAuthorityHash: receipt.authorityHash, receiptOwnerId: receipt.ownerId,
      ...(receipt.ownerProcess ? { receiptOwnerProcessDigest: hexDigest(receipt.ownerProcess) } : {}),
      journalGeneration: journal.generation,
      transitionsDigest: hexDigest(journal.transitions), recoveryEpoch,
      deviceId: device.deviceId, deviceFingerprint: device.fingerprint
    };
    return { ...base, caseDigest: hexDigest(base) };
  }

  async #readVerifiedLedger(): Promise<Ledger> {
    let raw: unknown;
    try { raw = JSON.parse(await readDurableStateText(this.#file, STORE)); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, decisions: [] };
      throw e;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw denied('Recovery audit ledger malformed.');
    const ledger = raw as Ledger;
    if (ledger.version !== 1 || !Array.isArray(ledger.decisions) || ledger.decisions.length > MAX_EVENTS) {
      throw denied('Recovery audit ledger version/size mismatch.');
    }
    const device = await this.#signer.loadExisting();
    if (!device) throw denied('Recovery device identity disappeared.');
    const ids = new Set<string>();
    let previous = '0'.repeat(64);
    for (let i = 0; i < ledger.decisions.length; i++) {
      const r = ledger.decisions[i]!;
      if (r.version !== 1 || r.epoch !== i + 1 || r.deviceId !== device.deviceId ||
          r.deviceFingerprint !== device.fingerprint || r.previousDigest !== previous ||
          !r.actionId || ids.has(r.actionId) || !validHash(r.actionDigest) ||
          !validHash(r.receiptAuthorityHash) ||
          (r.receiptOwnerProcessDigest !== undefined && !validHash(r.receiptOwnerProcessDigest)) ||
          !validHash(r.caseDigest) ||
          !validHash(r.transitionsDigest) || !r.receiptOwnerId ||
          r.journalGeneration !== 1 ||
          r.operatorAttestation !== 'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED' ||
          !Number.isFinite(Date.parse(r.adjudicatedAt)) ||
          typeof r.signature !== 'string' || r.signature.length < 20) {
        throw denied('Signed operator history identity, epoch or chain is invalid.');
      }
      const { signature, ...unsigned } = r;
      if (!await this.#signer.verify(Buffer.from(canonicalJson(unsigned)), signature)) {
        throw denied('Signed operator history proof is invalid.');
      }
      previous = hexDigest(r);
      ids.add(r.actionId);
    }
    return ledger;
  }
}
