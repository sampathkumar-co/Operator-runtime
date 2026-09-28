import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { appendDurableStateText, readDurableStateText } from './durable-state.ts';

export type ConversationTurnRole = 'user' | 'assistant' | 'system';

export interface ConversationTurn {
  version: 1;
  id: string;
  conversationId: string;
  sequence: number;
  role: ConversationTurnRole;
  contentDigest: string;
  content?: string;
  createdAt: string;
  supersedes?: string[];
}

const MAX_TURN_BYTES = 256 * 1024;
const MAX_LEDGER_BYTES = 256 * 1024 * 1024;

export class ConversationLedger {
  #file: string;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, conversationId: string) {
    const id = boundedId(conversationId, 'conversationId');
    this.#file = path.join(path.resolve(stateDir), 'conversations', `${id}.ndjson`);
  }

  async append(input: {
    role: ConversationTurnRole;
    content: string;
    retainContent?: boolean;
    supersedes?: string[];
  }): Promise<ConversationTurn> {
    const run = this.#serial.then(async () => {
      const existing = await this.list();
      const content = boundedText(input.content, MAX_TURN_BYTES, 'content');
      const role = validRole(input.role);
      const supersedes = uniqueIds(input.supersedes ?? []);
      const createdAt = new Date().toISOString();
      const conversationId = path.basename(this.#file, '.ndjson');
      const turn: ConversationTurn = {
        version: 1,
        id: crypto.randomUUID(),
        conversationId,
        sequence: existing.length + 1,
        role,
        contentDigest: crypto.createHash('sha256').update(content).digest('hex'),
        ...(input.retainContent === false ? {} : { content }),
        createdAt,
        ...(supersedes.length ? { supersedes } : {})
      };
      await appendDurableStateText(this.#file, `${JSON.stringify(turn)}\n`, {
        maxBytes: MAX_LEDGER_BYTES,
        errorCode: 'CONVERSATION_LEDGER_CORRUPT',
        invalidMessage: 'Conversation ledger is invalid.'
      });
      return turn;
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async list(): Promise<ConversationTurn[]> {
    let text: string;
    try {
      text = await readDurableStateText(this.#file, {
        maxBytes: MAX_LEDGER_BYTES,
        errorCode: 'CONVERSATION_LEDGER_CORRUPT',
        invalidMessage: 'Conversation ledger is invalid.'
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (!text.trim()) return [];
    const turns = text.trimEnd().split('\n').map((line, index) => parseTurn(line, index + 1));
    for (let i = 0; i < turns.length; i += 1) {
      if (turns[i]!.sequence !== i + 1) throw new OperatorError('CONVERSATION_LEDGER_CORRUPT', 'Conversation ledger sequence is not contiguous.');
    }
    return turns;
  }
}

function parseTurn(line: string, expectedSequence: number): ConversationTurn {
  let raw: any;
  try { raw = JSON.parse(line); } catch { throw new OperatorError('CONVERSATION_LEDGER_CORRUPT', 'Conversation ledger contains invalid JSON.'); }
  if (raw?.version !== 1) throw new OperatorError('CONVERSATION_LEDGER_CORRUPT', 'Conversation ledger version is invalid.');
  const turn: ConversationTurn = {
    version: 1,
    id: boundedId(raw.id, 'id'),
    conversationId: boundedId(raw.conversationId, 'conversationId'),
    sequence: integer(raw.sequence, 1, Number.MAX_SAFE_INTEGER, 'sequence'),
    role: validRole(raw.role),
    contentDigest: digest(raw.contentDigest),
    ...(raw.content === undefined ? {} : { content: boundedText(raw.content, MAX_TURN_BYTES, 'content') }),
    createdAt: iso(raw.createdAt),
    ...(raw.supersedes === undefined ? {} : { supersedes: uniqueIds(raw.supersedes) })
  };
  if (turn.sequence !== expectedSequence) throw new OperatorError('CONVERSATION_LEDGER_CORRUPT', 'Conversation ledger sequence mismatch.');
  if (turn.content && crypto.createHash('sha256').update(turn.content).digest('hex') !== turn.contentDigest) {
    throw new OperatorError('CONVERSATION_LEDGER_CORRUPT', 'Conversation content digest does not match.');
  }
  return turn;
}

function validRole(input: unknown): ConversationTurnRole {
  if (input === 'user' || input === 'assistant' || input === 'system') return input;
  throw new OperatorError('CONVERSATION_INPUT_INVALID', 'Conversation role is invalid.');
}
function boundedId(input: unknown, label: string): string {
  const v = String(input ?? '');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(v)) throw new OperatorError('CONVERSATION_INPUT_INVALID', `${label} is invalid.`);
  return v;
}
function boundedText(input: unknown, maxBytes: number, label: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0') || Buffer.byteLength(input, 'utf8') > maxBytes) {
    throw new OperatorError('CONVERSATION_INPUT_INVALID', `${label} is invalid.`);
  }
  return input;
}
function digest(input: unknown): string {
  const v = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(v)) throw new OperatorError('CONVERSATION_LEDGER_CORRUPT', 'contentDigest is invalid.');
  return v;
}
function iso(input: unknown): string {
  const v = String(input ?? '');
  const n = Date.parse(v);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== v) throw new OperatorError('CONVERSATION_LEDGER_CORRUPT', 'createdAt is invalid.');
  return v;
}
function uniqueIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 1000) throw new OperatorError('CONVERSATION_INPUT_INVALID', 'supersedes is invalid.');
  const ids = input.map((value) => boundedId(value, 'supersedes id'));
  if (new Set(ids).size !== ids.length) throw new OperatorError('CONVERSATION_INPUT_INVALID', 'supersedes contains duplicates.');
  return ids;
}
function integer(input: unknown, min: number, max: number, label: string): number {
  const n = Number(input);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new OperatorError('CONVERSATION_LEDGER_CORRUPT', `${label} is invalid.`);
  return n;
}
