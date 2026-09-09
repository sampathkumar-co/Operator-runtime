export type ActionRisk = 'read' | 'write' | 'external' | 'system' | 'destructive';
export type TaskState = 'PENDING' | 'RUNNING' | 'BLOCKED' | 'FAILED' | 'VERIFIED' | 'SKIPPED';
export type EvidenceStatus = 'pass' | 'fail' | 'info';
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

export interface ActionRequest {
  id: string;
  capability: string;
  risk: ActionRisk;
  input: Record<string, unknown>;
  provenance: Provenance;
  taskId?: string;
  target?: string;
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
  };
  durationMs: number;
}

export interface PermissionProfile {
  allowedCapabilities: string[];
  allowedRoots: string[];
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

export interface CapabilityProvider {
  name: string;
  supports(action: ActionRequest): boolean | Promise<boolean>;
  score(action: ActionRequest): CapabilityScore | Promise<CapabilityScore>;
  execute(action: ActionRequest): Promise<ActionResult>;
  close?(): void | Promise<void>;
}
