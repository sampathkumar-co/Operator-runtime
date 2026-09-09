import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const SECRET_KEY = /(token|password|secret|authorization|cookie|private.?key|api.?key)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(child, depth + 1);
    }
    return output;
  }
  if (typeof value === 'string' && value.length > 16_384) return `${value.slice(0, 16_384)}…[TRUNCATED]`;
  return value;
}

export interface AuditEvent {
  id?: string;
  timestamp?: string;
  taskId?: string;
  sessionId?: string;
  deviceId?: string;
  capability: string;
  target?: string;
  result: 'allowed' | 'blocked' | 'success' | 'failure';
  risk: string;
  evidenceRefs?: string[];
  rollbackState?: string;
  details?: Record<string, unknown>;
}

export class AuditLog {
  #file: string;

  constructor(stateDir: string) {
    this.#file = path.join(path.resolve(stateDir), 'audit.ndjson');
  }

  async append(event: AuditEvent): Promise<AuditEvent> {
    await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const normalized = redact({
      ...event,
      id: event.id ?? crypto.randomUUID(),
      timestamp: event.timestamp ?? new Date().toISOString()
    }) as AuditEvent;
    await fs.appendFile(this.#file, `${JSON.stringify(normalized)}\n`, { encoding: 'utf8', mode: 0o600 });
    return normalized;
  }

  async tail(limit = 100): Promise<AuditEvent[]> {
    try {
      const lines = (await fs.readFile(this.#file, 'utf8')).trim().split('\n').filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(limit, 1000))).map((line) => JSON.parse(line) as AuditEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
