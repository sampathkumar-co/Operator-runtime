from pathlib import Path

p = Path('src/core/audit.ts')
s = p.read_text()

s = s.replace("import fs from 'node:fs/promises';\n", '', 1)
anchor = "import { OperatorError } from './errors.ts';\n"
if s.count(anchor) != 1:
    raise SystemExit(f'OperatorError import anchor mismatch: {s.count(anchor)}')
s = s.replace(anchor, anchor + "import { appendDurableStateText, readDurableStateText, writeDurableStateText } from './durable-state.ts';\n", 1)

anchor = "const HASH_RE = /^[0-9a-f]{64}$/;\n"
addition = """const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_AUDIT_BYTES = 256 * 1024 * 1024;
const MAX_AUDIT_HEAD_BYTES = 64 * 1024;
const MAX_AUDIT_EVENT_BYTES = 256 * 1024;
const MAX_REDACT_COLLECTION_ITEMS = 1000;
const MAX_TAIL_EVENTS = 1000;
const AUDIT_STATE_OPTIONS = {
  maxBytes: MAX_AUDIT_BYTES,
  errorCode: 'AUDIT_INTEGRITY_FAILED',
  invalidMessage: 'Audit log file is invalid.'
} as const;
const AUDIT_HEAD_OPTIONS = {
  maxBytes: MAX_AUDIT_HEAD_BYTES,
  errorCode: 'AUDIT_INTEGRITY_FAILED',
  invalidMessage: 'Audit head file is invalid.'
} as const;
"""
if s.count(anchor) != 1:
    raise SystemExit('HASH_RE anchor mismatch')
s = s.replace(anchor, addition, 1)

old = """function redact(value: unknown, depth = 0): unknown {
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
"""
new = """function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (Array.isArray(value)) {
    const output = value.slice(0, MAX_REDACT_COLLECTION_ITEMS).map((item) => redact(item, depth + 1));
    if (value.length > MAX_REDACT_COLLECTION_ITEMS) output.push(`[TRUNCATED_${value.length - MAX_REDACT_COLLECTION_ITEMS}_ITEMS]`);
    return output;
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, child] of entries.slice(0, MAX_REDACT_COLLECTION_ITEMS)) {
      output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(child, depth + 1);
    }
    if (entries.length > MAX_REDACT_COLLECTION_ITEMS) output.__operatorTruncatedEntries = entries.length - MAX_REDACT_COLLECTION_ITEMS;
    return output;
  }
  if (typeof value === 'string' && value.length > 16_384) return `${value.slice(0, 16_384)}…[TRUNCATED]`;
  return value;
}
"""
if s.count(old) != 1:
    raise SystemExit('redact block mismatch')
s = s.replace(old, new, 1)

old = """      await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      const head = await this.#loadHead();
"""
new = """      const head = await this.#loadHead();
"""
if s.count(old) != 1:
    raise SystemExit('append mkdir anchor mismatch')
s = s.replace(old, new, 1)

old = """      appended = chainEvent(base, head.headHash);
      await fs.appendFile(this.#file, `${JSON.stringify(appended)}\n`, { encoding: 'utf8', mode: 0o600 });
      const next = { count: head.count + 1, headHash: appended.hash! };
"""
new = """      appended = chainEvent(base, head.headHash);
      const line = `${JSON.stringify(appended)}\n`;
      if (Buffer.byteLength(line, 'utf8') > MAX_AUDIT_EVENT_BYTES) {
        throw new OperatorError('AUDIT_EVENT_TOO_LARGE', `Audit event exceeds ${MAX_AUDIT_EVENT_BYTES} UTF-8 bytes after redaction.`);
      }
      await appendDurableStateText(this.#file, line, AUDIT_STATE_OPTIONS);
      const next = { count: head.count + 1, headHash: appended.hash! };
"""
if s.count(old) != 1:
    raise SystemExit('append write anchor mismatch')
s = s.replace(old, new, 1)

old = """  async tail(limit = 100): Promise<AuditEvent[]> {
    await this.#queue;
    const verified = await this.#readAndVerify(true);
    return verified.events.slice(-Math.max(1, Math.min(limit, 1000)));
  }
"""
new = """  async tail(limit = 100): Promise<AuditEvent[]> {
    await this.#queue;
    const verified = await this.#readAndVerify(true);
    const parsed = Number(limit);
    const bounded = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), MAX_TAIL_EVENTS) : 100;
    return verified.events.slice(-bounded);
  }
"""
if s.count(old) != 1:
    raise SystemExit('tail block mismatch')
s = s.replace(old, new, 1)

old = "      text = await fs.readFile(this.#file, 'utf8');"
new = "      text = await readDurableStateText(this.#file, AUDIT_STATE_OPTIONS);"
if s.count(old) != 1:
    raise SystemExit('audit read anchor mismatch')
s = s.replace(old, new, 1)

old = "    await atomicWrite(this.#file, `${migrated.map((event) => JSON.stringify(event)).join('\\n')}\\n`);"
new = "    await writeDurableStateText(this.#file, `${migrated.map((event) => JSON.stringify(event)).join('\\n')}\\n`, AUDIT_STATE_OPTIONS);"
if s.count(old) != 1:
    raise SystemExit('legacy migration write anchor mismatch')
s = s.replace(old, new, 1)

old = "      anchor = JSON.parse(await fs.readFile(this.#headFile, 'utf8')) as AuditHead;"
new = "      anchor = JSON.parse(await readDurableStateText(this.#headFile, AUDIT_HEAD_OPTIONS)) as AuditHead;"
if s.count(old) != 1:
    raise SystemExit('audit head read anchor mismatch')
s = s.replace(old, new, 1)

old = "    await atomicWrite(this.#headFile, `${JSON.stringify(record, null, 2)}\\n`);"
new = "    await writeDurableStateText(this.#headFile, `${JSON.stringify(record, null, 2)}\\n`, AUDIT_HEAD_OPTIONS);"
if s.count(old) != 1:
    raise SystemExit('audit head write anchor mismatch')
s = s.replace(old, new, 1)

start = s.find("\nasync function atomicWrite(target: string, content: string): Promise<void> {")
if start < 0:
    raise SystemExit('atomicWrite helper not found')
s = s[:start] + '\n'

p.write_text(s)
