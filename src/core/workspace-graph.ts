import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

export type WorkspaceNodeKind =
  | 'workspace' | 'repository' | 'worktree' | 'branch' | 'commit'
  | 'file' | 'symbol' | 'diagnostic' | 'test'
  | 'terminal' | 'process' | 'port' | 'container' | 'database'
  | 'browser-tab' | 'app-window' | 'ui-element' | 'screenshot'
  | 'task' | 'plan' | 'approval' | 'evidence' | 'artifact' | 'checkpoint' | 'intent';

export type WorkspaceEdgeKind =
  | 'contains' | 'references' | 'owns' | 'runs' | 'listens-on' | 'connects-to'
  | 'derived-from' | 'verifies' | 'blocks' | 'depends-on' | 'belongs-to'
  | 'produced-by' | 'observes';

export interface WorkspaceGraphNode {
  id: string;
  kind: WorkspaceNodeKind;
  label: string;
  resourceKey?: string;
  revision?: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface WorkspaceGraphEdge {
  from: string;
  to: string;
  kind: WorkspaceEdgeKind;
  metadata: Record<string, string | number | boolean | null>;
}

export interface WorkspaceGraph {
  schemaVersion: 1;
  id: string;
  rootNodeId: string;
  sourceWorldRevision?: string;
  observedAt: string;
  nodes: WorkspaceGraphNode[];
  edges: WorkspaceGraphEdge[];
}

const NODE_KINDS = new Set<WorkspaceNodeKind>([
  'workspace','repository','worktree','branch','commit','file','symbol','diagnostic','test',
  'terminal','process','port','container','database','browser-tab','app-window','ui-element',
  'screenshot','task','plan','approval','evidence','artifact','checkpoint','intent'
]);
const EDGE_KINDS = new Set<WorkspaceEdgeKind>([
  'contains','references','owns','runs','listens-on','connects-to','derived-from','verifies',
  'blocks','depends-on','belongs-to','produced-by','observes'
]);
const ID = /^[A-Za-z0-9._:@/+\-=]{1,512}$/;
const MAX_NODES = 100_000;
const MAX_EDGES = 500_000;

export function createWorkspaceGraph(input: {
  rootNodeId: string;
  sourceWorldRevision?: string;
  observedAt?: string;
  nodes: WorkspaceGraphNode[];
  edges?: WorkspaceGraphEdge[];
}): WorkspaceGraph {
  const normalized = normalizeWorkspaceGraph({
    schemaVersion: 1,
    id: '0'.repeat(64),
    rootNodeId: input.rootNodeId,
    ...(input.sourceWorldRevision ? { sourceWorldRevision: input.sourceWorldRevision } : {}),
    observedAt: input.observedAt ?? new Date().toISOString(),
    nodes: input.nodes,
    edges: input.edges ?? []
  }, false);
  const id = workspaceGraphDigest(normalized);
  return { ...normalized, id };
}

export function normalizeWorkspaceGraph(input: unknown, verifyId = true): WorkspaceGraph {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Workspace Graph must be an object.');
  const raw = structuredClone(input) as WorkspaceGraph;
  if (raw.schemaVersion !== 1) throw invalid('Workspace Graph schemaVersion must be 1.');
  const rootNodeId = validId(raw.rootNodeId, 'rootNodeId');
  const observedAt = canonicalIso(raw.observedAt, 'observedAt');
  const sourceWorldRevision = raw.sourceWorldRevision === undefined ? undefined : validId(raw.sourceWorldRevision, 'sourceWorldRevision');
  if (!Array.isArray(raw.nodes) || raw.nodes.length < 1 || raw.nodes.length > MAX_NODES) throw invalid('Workspace Graph node count is invalid.');
  if (!Array.isArray(raw.edges) || raw.edges.length > MAX_EDGES) throw invalid('Workspace Graph edge count is invalid.');

  const ids = new Set<string>();
  const nodes = raw.nodes.map((node) => normalizeNode(node, ids));
  if (!ids.has(rootNodeId)) throw invalid('Workspace Graph rootNodeId does not exist.');

  const edges = raw.edges.map((edge) => normalizeEdge(edge, ids));
  const normalized: WorkspaceGraph = {
    schemaVersion: 1,
    id: String(raw.id ?? ''),
    rootNodeId,
    ...(sourceWorldRevision ? { sourceWorldRevision } : {}),
    observedAt,
    nodes: nodes.sort((a,b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a,b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind))
  };
  const digest = workspaceGraphDigest(normalized);
  if (verifyId && normalized.id !== digest) throw invalid('Workspace Graph id does not match its content digest.');
  normalized.id = digest;
  return normalized;
}

export function workspaceGraphDigest(graph: Omit<WorkspaceGraph, 'id'> | WorkspaceGraph): string {
  const value = { ...graph, id: undefined };
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function workspaceNeighbors(graphInput: WorkspaceGraph, nodeIdInput: string): WorkspaceGraphNode[] {
  const graph = normalizeWorkspaceGraph(graphInput);
  const nodeId = validId(nodeIdInput, 'nodeId');
  const connected = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.from === nodeId) connected.add(edge.to);
    if (edge.to === nodeId) connected.add(edge.from);
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return [...connected].sort().map((id) => byId.get(id)!).filter(Boolean);
}

function normalizeNode(input: unknown, seen: Set<string>): WorkspaceGraphNode {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Workspace Graph node is invalid.');
  const raw = input as Record<string, unknown>;
  const id = validId(raw.id, 'node id');
  if (seen.has(id)) throw invalid(`Duplicate Workspace Graph node id: ${id}`);
  seen.add(id);
  if (!NODE_KINDS.has(raw.kind as WorkspaceNodeKind)) throw invalid(`Workspace Graph node kind is invalid: ${String(raw.kind)}`);
  const label = boundedText(raw.label, 1024, 'node label');
  const resourceKey = raw.resourceKey === undefined ? undefined : boundedText(raw.resourceKey, 4096, 'resourceKey');
  const revision = raw.revision === undefined ? undefined : boundedText(raw.revision, 1024, 'revision');
  return {
    id,
    kind: raw.kind as WorkspaceNodeKind,
    label,
    ...(resourceKey ? { resourceKey } : {}),
    ...(revision ? { revision } : {}),
    metadata: scalarMetadata(raw.metadata)
  };
}

function normalizeEdge(input: unknown, ids: Set<string>): WorkspaceGraphEdge {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Workspace Graph edge is invalid.');
  const raw = input as Record<string, unknown>;
  const from = validId(raw.from, 'edge from');
  const to = validId(raw.to, 'edge to');
  if (!ids.has(from) || !ids.has(to)) throw invalid('Workspace Graph edge references an unknown node.');
  if (!EDGE_KINDS.has(raw.kind as WorkspaceEdgeKind)) throw invalid(`Workspace Graph edge kind is invalid: ${String(raw.kind)}`);
  return { from, to, kind: raw.kind as WorkspaceEdgeKind, metadata: scalarMetadata(raw.metadata) };
}

function scalarMetadata(input: unknown): Record<string, string | number | boolean | null> {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Workspace Graph metadata must be an object.');
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 64) throw invalid('Workspace Graph metadata is too large.');
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of entries.sort(([a],[b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw invalid(`Workspace Graph metadata key is invalid: ${key}`);
    if (value !== null && !['string','number','boolean'].includes(typeof value)) throw invalid(`Workspace Graph metadata value is invalid: ${key}`);
    if (typeof value === 'string' && Buffer.byteLength(value,'utf8') > 4096) throw invalid(`Workspace Graph metadata value is too large: ${key}`);
    if (typeof value === 'number' && !Number.isFinite(value)) throw invalid(`Workspace Graph metadata number is invalid: ${key}`);
    output[key] = value as string | number | boolean | null;
  }
  return output;
}

function validId(input: unknown, label: string): string {
  if (typeof input !== 'string' || !ID.test(input)) throw invalid(`${label} is invalid.`);
  return input;
}

function boundedText(input: unknown, maxBytes: number, label: string): string {
  if (typeof input !== 'string' || !input.trim() || Buffer.byteLength(input,'utf8') > maxBytes) throw invalid(`${label} is invalid.`);
  return input;
}

function canonicalIso(input: unknown, label: string): string {
  const text = String(input ?? '');
  if (!text || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) throw invalid(`${label} must be canonical ISO.`);
  return text;
}

function invalid(message: string): OperatorError {
  return new OperatorError('WORKSPACE_GRAPH_INVALID', message);
}
