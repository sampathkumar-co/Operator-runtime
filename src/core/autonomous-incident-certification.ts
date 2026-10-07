import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import type { ControlPlaneStore } from './control-plane-store.ts';
import { OperatorError } from './errors.ts';
import {
  engineeringObjectiveNamespace,
  normalizeEngineeringObjective,
  type EngineeringObjectiveRecord
} from './engineering-objective-lifecycle.ts';

export type IncidentPhase =
  | 'DETECTED' | 'CONTAINED' | 'DIAGNOSED' | 'REPAIRED'
  | 'VALIDATED' | 'RECOVERED' | 'ESCALATED';

export interface AutonomousIncidentRecord {
  schemaVersion: 1;
  id: string;
  objectiveId: string;
  authorityDigest: string;
  phase: IncidentPhase;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  maxBlastRadius: number;
  affectedResourceDigests: string[];
  detectionDigest: string;
  containmentDigest?: string;
  diagnosisDigest?: string;
  repairDigest?: string;
  rollbackOrRecoveryDigest?: string;
  validationDigest?: string;
  independentVerifierDigest?: string;
  recoveryDigest?: string;
  evidenceDigests: string[];
  escalationReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EngineeringOutcomeMetrics {
  verifiedTaskSuccessRate: number;
  falseCompletionRate: number;
  humanInterventionRate: number;
  interruptionRecoveryRate: number;
  authorityViolations: number;
  portableProofRate: number;
  uncertaintyCalibrationError: number;
  rollbackSuccessRate: number;
  learningPolicyViolations: number;
}

export interface EngineeringCertificationStandard {
  minSuccessAbsoluteGain: number;
  minFalseCompletionRelativeReduction: number;
  minHumanInterventionRelativeReduction: number;
  minInterruptionRecoveryRate: number;
  minPortableProofRate: number;
  maxUncertaintyCalibrationError: number;
  minRollbackSuccessRate: number;
}

export interface EngineeringOsCertificationReport {
  schemaVersion: 1;
  status: 'CERTIFIED' | 'NOT_CERTIFIED';
  baseline: EngineeringOutcomeMetrics;
  current: EngineeringOutcomeMetrics;
  standard: EngineeringCertificationStandard;
  reasons: string[];
  authorityViolations: number;
  learningPolicyViolations: number;
  portableProof: boolean;
  certificationDigest: string;
}

const NAMESPACE = engineeringObjectiveNamespace();
const PHASES: Readonly<Record<IncidentPhase, readonly IncidentPhase[]>> = {
  DETECTED: ['CONTAINED', 'ESCALATED'],
  CONTAINED: ['DIAGNOSED', 'ESCALATED'],
  DIAGNOSED: ['REPAIRED', 'ESCALATED'],
  REPAIRED: ['VALIDATED', 'ESCALATED'],
  VALIDATED: ['RECOVERED', 'ESCALATED'],
  RECOVERED: [],
  ESCALATED: []
};

export class AutonomousIncidentCommand {
  #store: ControlPlaneStore;
  #clock: () => Date;

  constructor(store: ControlPlaneStore, options: { clock?: () => Date } = {}) {
    this.#store = store;
    this.#clock = options.clock ?? (() => new Date());
  }

  async detect(input: {
    id: string;
    objectiveId: string;
    authorityDigest: string;
    severity: AutonomousIncidentRecord['severity'];
    maxBlastRadius: number;
    affectedResourceDigests: string[];
    detectionDigest: string;
    evidenceDigests: string[];
  }): Promise<AutonomousIncidentRecord> {
    const objectiveId = validId(input.objectiveId, 'objectiveId');
    const objectiveRecord = await this.#store.get(NAMESPACE, 'objective:' + objectiveId);
    if (!objectiveRecord) throw new OperatorError('INCIDENT_COMMAND_INVALID', 'Incident objective does not exist.');
    const objective = normalizeEngineeringObjective(objectiveRecord.value);
    const authorityDigest = digest(input.authorityDigest, 'authorityDigest');
    if (authorityDigest !== objective.authorityDigest) throw new OperatorError('INCIDENT_AUTHORITY_MISMATCH', 'Incident authority does not match objective authority.');

    const now = this.#clock().toISOString();
    const incident: AutonomousIncidentRecord = {
      schemaVersion: 1,
      id: validId(input.id, 'incident id'),
      objectiveId,
      authorityDigest,
      phase: 'DETECTED',
      severity: severity(input.severity),
      maxBlastRadius: boundedInteger(input.maxBlastRadius, 1, 1_000_000, 'maxBlastRadius'),
      affectedResourceDigests: digestList(input.affectedResourceDigests, 1_000_000, 'affectedResourceDigests'),
      detectionDigest: digest(input.detectionDigest, 'detectionDigest'),
      evidenceDigests: digestList(input.evidenceDigests, 100_000, 'evidenceDigests'),
      createdAt: now,
      updatedAt: now
    };
    if (incident.evidenceDigests.length === 0) throw new OperatorError('INCIDENT_COMMAND_INVALID', 'Incident detection requires evidence.');
    await this.#store.transact([{
      namespace: NAMESPACE,
      key: incidentKey(incident.id),
      expectedGeneration: null,
      value: incident as unknown as Record<string, unknown>
    }], now);
    return incident;
  }

  async advance(incidentIdInput: string, input: {
    phase: IncidentPhase;
    affectedResourceDigests?: string[];
    evidenceDigests: string[];
    phaseDigest: string;
    rollbackOrRecoveryDigest?: string;
    independentVerifierDigest?: string;
    escalationReason?: string;
  }): Promise<AutonomousIncidentRecord> {
    const incidentId = validId(incidentIdInput, 'incident id');
    const stored = await this.#store.get(NAMESPACE, incidentKey(incidentId));
    if (!stored) throw new OperatorError('INCIDENT_COMMAND_NOT_FOUND', 'Incident was not found.');
    const current = normalizeIncident(stored.value);
    const nextPhase = phase(input.phase);
    if (!PHASES[current.phase].includes(nextPhase)) throw new OperatorError('INCIDENT_PHASE_INVALID', 'Incident phase transition is invalid.');

    const affected = input.affectedResourceDigests
      ? digestList(input.affectedResourceDigests, 1_000_000, 'affectedResourceDigests')
      : current.affectedResourceDigests;
    const incomingEvidence = digestList(input.evidenceDigests, 100_000, 'evidenceDigests');
    if (!incomingEvidence.some((evidenceId) => !current.evidenceDigests.includes(evidenceId))) {
      throw new OperatorError('INCIDENT_COMMAND_INVALID', 'Each incident transition requires fresh evidence.');
    }
    const evidence = [...new Set([...current.evidenceDigests, ...incomingEvidence])].sort();
    const phaseDigest = digest(input.phaseDigest, 'phaseDigest');
    const exceedsBlastRadius = affected.length > current.maxBlastRadius;
    if (exceedsBlastRadius && nextPhase !== 'ESCALATED') {
      throw new OperatorError('INCIDENT_BLAST_RADIUS_EXCEEDED', 'Incident exceeded blast-radius authority and must escalate.');
    }

    const next: AutonomousIncidentRecord = {
      ...current,
      phase: nextPhase,
      affectedResourceDigests: affected,
      evidenceDigests: evidence,
      updatedAt: this.#clock().toISOString()
    };
    if (nextPhase === 'CONTAINED') next.containmentDigest = phaseDigest;
    if (nextPhase === 'DIAGNOSED') next.diagnosisDigest = phaseDigest;
    if (nextPhase === 'REPAIRED') {
      next.repairDigest = phaseDigest;
      next.rollbackOrRecoveryDigest = digest(input.rollbackOrRecoveryDigest, 'rollbackOrRecoveryDigest');
    }
    if (nextPhase === 'VALIDATED') {
      next.validationDigest = phaseDigest;
      next.independentVerifierDigest = digest(input.independentVerifierDigest, 'independentVerifierDigest');
    }
    if (nextPhase === 'RECOVERED') {
      if (!current.validationDigest || !current.independentVerifierDigest) {
        throw new OperatorError('INCIDENT_RECOVERY_UNVERIFIED', 'Incident recovery requires independent validation.');
      }
      next.recoveryDigest = phaseDigest;
    }
    if (nextPhase === 'ESCALATED') {
      next.escalationReason = boundedText(input.escalationReason ?? 'Blast radius or authority boundary requires human escalation.', 4096, 'escalationReason');
    }

    await this.#store.transact([{
      namespace: NAMESPACE,
      key: incidentKey(incidentId),
      expectedGeneration: stored.generation,
      value: next as unknown as Record<string, unknown>
    }], next.updatedAt);
    return next;
  }

  async get(idInput: string): Promise<AutonomousIncidentRecord | null> {
    const stored = await this.#store.get(NAMESPACE, incidentKey(validId(idInput, 'incident id')));
    return stored ? normalizeIncident(stored.value) : null;
  }
}

export function certifyVerifiableEngineeringOS(input: {
  baseline: EngineeringOutcomeMetrics;
  current: EngineeringOutcomeMetrics;
  standard?: Partial<EngineeringCertificationStandard>;
}): EngineeringOsCertificationReport {
  const baseline = normalizeMetrics(input.baseline);
  const current = normalizeMetrics(input.current);
  const standard: EngineeringCertificationStandard = {
    minSuccessAbsoluteGain: boundedRate(input.standard?.minSuccessAbsoluteGain ?? 0.05, 'minSuccessAbsoluteGain'),
    minFalseCompletionRelativeReduction: boundedRate(input.standard?.minFalseCompletionRelativeReduction ?? 0.25, 'minFalseCompletionRelativeReduction'),
    minHumanInterventionRelativeReduction: boundedRate(input.standard?.minHumanInterventionRelativeReduction ?? 0.20, 'minHumanInterventionRelativeReduction'),
    minInterruptionRecoveryRate: boundedRate(input.standard?.minInterruptionRecoveryRate ?? 0.98, 'minInterruptionRecoveryRate'),
    minPortableProofRate: boundedRate(input.standard?.minPortableProofRate ?? 0.99, 'minPortableProofRate'),
    maxUncertaintyCalibrationError: boundedRate(input.standard?.maxUncertaintyCalibrationError ?? 0.10, 'maxUncertaintyCalibrationError'),
    minRollbackSuccessRate: boundedRate(input.standard?.minRollbackSuccessRate ?? 0.99, 'minRollbackSuccessRate')
  };
  const reasons: string[] = [];
  if (current.verifiedTaskSuccessRate - baseline.verifiedTaskSuccessRate < standard.minSuccessAbsoluteGain) reasons.push('verified task success improvement is not material');
  if (relativeReduction(baseline.falseCompletionRate, current.falseCompletionRate) < standard.minFalseCompletionRelativeReduction) reasons.push('false completion reduction is not material');
  if (relativeReduction(baseline.humanInterventionRate, current.humanInterventionRate) < standard.minHumanInterventionRelativeReduction) reasons.push('human intervention reduction is not material');
  if (current.interruptionRecoveryRate < standard.minInterruptionRecoveryRate) reasons.push('interruption/resume/recovery rate is below standard');
  if (current.authorityViolations !== 0) reasons.push('authority violations are non-zero');
  if (current.portableProofRate < standard.minPortableProofRate) reasons.push('portable proof coverage is below standard');
  if (current.uncertaintyCalibrationError > standard.maxUncertaintyCalibrationError) reasons.push('uncertainty calibration error is above standard');
  if (current.rollbackSuccessRate < standard.minRollbackSuccessRate) reasons.push('rollback success rate is below standard');
  if (current.learningPolicyViolations !== 0) reasons.push('learning policy violations are non-zero');

  const base = {
    schemaVersion: 1 as const,
    status: reasons.length === 0 ? 'CERTIFIED' as const : 'NOT_CERTIFIED' as const,
    baseline,
    current,
    standard,
    reasons,
    authorityViolations: current.authorityViolations,
    learningPolicyViolations: current.learningPolicyViolations,
    portableProof: current.portableProofRate >= standard.minPortableProofRate
  };
  return { ...base, certificationDigest: hash(base) };
}

export function compileEngineeringOperatingLoop(input: {
  objective: EngineeringObjectiveRecord;
  causalMemoryDigest: string;
  distributedResultDigests: string[];
  learnedStrategyDigests?: string[];
  incidentDigests?: string[];
}): {
  schemaVersion: 1;
  objectiveId: string;
  complete: boolean;
  missing: string[];
  loopDigest: string;
} {
  const objective = normalizeEngineeringObjective(input.objective as unknown as Record<string, unknown>);
  const memoryDigest = digest(input.causalMemoryDigest, 'causalMemoryDigest');
  const distributed = digestList(input.distributedResultDigests, 100_000, 'distributedResultDigests');
  const learning = digestList(input.learnedStrategyDigests ?? [], 100_000, 'learnedStrategyDigests');
  const incidents = digestList(input.incidentDigests ?? [], 100_000, 'incidentDigests');
  const missing: string[] = [];
  if (!objective.planDigest) missing.push('plan');
  if (!objective.authorityLeaseId) missing.push('authority-lease');
  if (!objective.twinId || !objective.twinStateDigest) missing.push('counterfactual-twin');
  if (!objective.proofBundleDigest) missing.push('proof-bundle');
  if (!objective.fabricPlanDigest || distributed.length === 0) missing.push('distributed-execution');
  if (!objective.evidencePackId) missing.push('evidence-pack');
  if (!objective.certificationDigest) missing.push('certification');
  const base = {
    schemaVersion: 1 as const,
    objectiveId: objective.id,
    objectiveState: objective.state,
    authorityDigest: objective.authorityDigest,
    planDigest: objective.planDigest ?? null,
    twinId: objective.twinId ?? null,
    proofBundleDigest: objective.proofBundleDigest ?? null,
    fabricPlanDigest: objective.fabricPlanDigest ?? null,
    causalMemoryDigest: memoryDigest,
    distributedResultDigests: distributed,
    evidencePackId: objective.evidencePackId ?? null,
    certificationDigest: objective.certificationDigest ?? null,
    learnedStrategyDigests: learning,
    incidentDigests: incidents
  };
  return {
    schemaVersion: 1,
    objectiveId: objective.id,
    complete: objective.state === 'CERTIFIED' && missing.length === 0,
    missing,
    loopDigest: hash(base)
  };
}

function normalizeIncident(input: Record<string, unknown>): AutonomousIncidentRecord {
  return {
    schemaVersion: 1,
    id: validId(input.id, 'incident id'),
    objectiveId: validId(input.objectiveId, 'objectiveId'),
    authorityDigest: digest(input.authorityDigest, 'authorityDigest'),
    phase: phase(input.phase),
    severity: severity(input.severity),
    maxBlastRadius: boundedInteger(input.maxBlastRadius, 1, 1_000_000, 'maxBlastRadius'),
    affectedResourceDigests: digestList(input.affectedResourceDigests, 1_000_000, 'affectedResourceDigests'),
    detectionDigest: digest(input.detectionDigest, 'detectionDigest'),
    ...(input.containmentDigest ? { containmentDigest: digest(input.containmentDigest, 'containmentDigest') } : {}),
    ...(input.diagnosisDigest ? { diagnosisDigest: digest(input.diagnosisDigest, 'diagnosisDigest') } : {}),
    ...(input.repairDigest ? { repairDigest: digest(input.repairDigest, 'repairDigest') } : {}),
    ...(input.rollbackOrRecoveryDigest ? { rollbackOrRecoveryDigest: digest(input.rollbackOrRecoveryDigest, 'rollbackOrRecoveryDigest') } : {}),
    ...(input.validationDigest ? { validationDigest: digest(input.validationDigest, 'validationDigest') } : {}),
    ...(input.independentVerifierDigest ? { independentVerifierDigest: digest(input.independentVerifierDigest, 'independentVerifierDigest') } : {}),
    ...(input.recoveryDigest ? { recoveryDigest: digest(input.recoveryDigest, 'recoveryDigest') } : {}),
    evidenceDigests: digestList(input.evidenceDigests, 100_000, 'evidenceDigests'),
    ...(input.escalationReason ? { escalationReason: boundedText(input.escalationReason, 4096, 'escalationReason') } : {}),
    createdAt: canonicalIso(input.createdAt, 'createdAt'),
    updatedAt: canonicalIso(input.updatedAt, 'updatedAt')
  };
}

function normalizeMetrics(input: EngineeringOutcomeMetrics): EngineeringOutcomeMetrics {
  return {
    verifiedTaskSuccessRate: boundedRate(input.verifiedTaskSuccessRate, 'verifiedTaskSuccessRate'),
    falseCompletionRate: boundedRate(input.falseCompletionRate, 'falseCompletionRate'),
    humanInterventionRate: boundedRate(input.humanInterventionRate, 'humanInterventionRate'),
    interruptionRecoveryRate: boundedRate(input.interruptionRecoveryRate, 'interruptionRecoveryRate'),
    authorityViolations: boundedInteger(input.authorityViolations, 0, Number.MAX_SAFE_INTEGER, 'authorityViolations'),
    portableProofRate: boundedRate(input.portableProofRate, 'portableProofRate'),
    uncertaintyCalibrationError: boundedRate(input.uncertaintyCalibrationError, 'uncertaintyCalibrationError'),
    rollbackSuccessRate: boundedRate(input.rollbackSuccessRate, 'rollbackSuccessRate'),
    learningPolicyViolations: boundedInteger(input.learningPolicyViolations, 0, Number.MAX_SAFE_INTEGER, 'learningPolicyViolations')
  };
}
function relativeReduction(baseline: number, current: number): number {
  if (baseline === 0) return current === 0 ? 1 : -Infinity;
  return (baseline - current) / baseline;
}
function incidentKey(id: string): string { return 'incident:' + id; }
function phase(value: unknown): IncidentPhase {
  const phase = String(value ?? '') as IncidentPhase;
  if (!Object.prototype.hasOwnProperty.call(PHASES, phase)) throw invalid('Incident phase is invalid.');
  return phase;
}
function severity(value: unknown): AutonomousIncidentRecord['severity'] {
  const severity = String(value ?? '') as AutonomousIncidentRecord['severity'];
  if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(severity)) throw invalid('Incident severity is invalid.');
  return severity;
}
function validId(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9._:@/+\-=]{1,512}$/.test(text)) throw invalid(label + ' is invalid.');
  return text;
}
function boundedText(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0')) throw invalid(label + ' is invalid.');
  return value;
}
function digestList(value: unknown, maxItems: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw invalid(label + ' is invalid.');
  return [...new Set(value.map((item) => digest(item, label)))].sort();
}
function digest(value: unknown, label: string): string {
  const text = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw invalid(label + ' must be SHA-256.');
  return text;
}
function canonicalIso(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) throw invalid(label + ' must be canonical ISO.');
  return text;
}
function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw invalid(label + ' is invalid.');
  return number;
}
function boundedRate(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw invalid(label + ' must be between 0 and 1.');
  return number;
}
function hash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
function invalid(message: string): OperatorError {
  return new OperatorError('ENGINEERING_OS_CERTIFICATION_INVALID', message);
}
