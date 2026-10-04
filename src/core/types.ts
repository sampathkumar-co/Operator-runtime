export type ActionRisk = 'read' | 'write' | 'external' | 'system' | 'destructive';
export type SideEffectState = 'none' | 'known' | 'uncertain';
export type ExecutionPhase = 'pre_dispatch' | 'dispatched' | 'effect_observed' | 'reconciled';
export type TaskState = 'PENDING' | 'RUNNING' | 'PAUSED' | 'CANCELLED' | 'BLOCKED' | 'FAILED' | 'VERIFIED' | 'SKIPPED';
export type EvidenceStatus = 'pass' | 'fail' | 'info';
export type EpistemicStatus =
  | 'KNOWN'
  | 'UNKNOWN'
  | 'AMBIGUOUS'
  | 'CONTRADICTED'
  | 'UNAVAILABLE'
  | 'UNAUTHORIZED'
  | 'EXECUTION_UNCERTAIN'
  | 'VERIFIED_FALSE';
export type ProvenanceKind =
  | 'user'
  | 'chatgpt'
  | 'trusted_policy'
  | 'runtime'
  | 'website'
  | 'file'
  | 'application'
  | 'terminal';

export interface Provenance {
  kind: ProvenanceKind;
  source?: string;
}

export interface Evidence {
  kind: string;
  status: EvidenceStatus;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export interface IntentBinding {
  conversationId: string;
  intentVersion: number;
  digest: string;
}

export interface ActionRequest {
  id: string;
  capability: string;
  risk: ActionRisk;
  input: Record<string, unknown>;
  provenance: Provenance;
  taskId?: string;
  target?: string;
  intent?: IntentBinding;
}

export interface ActionResult {
  ok: boolean;
  capability: string;
  provider: string;
  output?: unknown;
  evidence: Evidence[];
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    sideEffectState?: SideEffectState;
    executionPhase?: ExecutionPhase;
    epistemicStatus?: Exclude<EpistemicStatus, 'KNOWN'>;
    details?: Record<string, unknown>;
  };
  durationMs: number;
}

export interface PermissionProfile {
  allowedCapabilities: string[];
  allowedRoots: string[];
  maxRisk?: ActionRisk;
  approvedActionIds?: string[];
  allowExternalWrites?: boolean;
  allowSystemChanges?: boolean;
  allowDestructive?: boolean;
}

export interface CapabilityScore {
  reliability: number;
  latency: number;
  determinism: number;
  security: number;
  reversibility: number;
  informationQuality: number;
  interactionCost: number;
}

export interface CapabilityAuthorityToken {
  claims: {
    version: 1;
    tokenId: string;
    capability: string;
    roots: string[];
    maxRisk: ActionRisk;
    actionIds: string[];
    issuedAt: string;
    expiresAt: string;
  };
  mac: string;
}

export interface CapabilityExecutionContext {
  signal?: AbortSignal;
  learningContext?: string;
  authorityToken?: CapabilityAuthorityToken;
  onProviderDispatch?: (providerName: string) => void | Promise<void>;
}

export interface ProviderReconciliationRequest {
  action: ActionRequest;
  priorResult?: ActionResult;
}

export interface ProviderReconciliationResult {
  status: 'completed' | 'not_applied' | 'uncertain';
  result?: ActionResult;
  evidence: Evidence[];
}

export interface CapabilityProvider {
  name: string;
  supports(action: ActionRequest): boolean | Promise<boolean>;
  advertises?(action: ActionRequest): boolean | Promise<boolean>;
  score(action: ActionRequest): CapabilityScore | Promise<CapabilityScore>;
  resolveRisk?(action: ActionRequest): ActionRisk | Promise<ActionRisk>;
  execute(action: ActionRequest, context?: CapabilityExecutionContext): Promise<ActionResult>;
  reconcile?(request: ProviderReconciliationRequest, context?: CapabilityExecutionContext): Promise<ProviderReconciliationResult>;
  close?(): void | Promise<void>;
}
