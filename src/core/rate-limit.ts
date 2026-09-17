import crypto from 'node:crypto';
import { isIP } from 'node:net';
import type http from 'node:http';

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

type Entry = { count: number; windowStartedAt: number };

export class FixedWindowRateLimiter {
  #limit: number;
  #windowMs: number;
  #maxKeys: number;
  #clock: () => number;
  #entries = new Map<string, Entry>();

  constructor(options: { limit: number; windowMs: number; maxKeys?: number; clock?: () => number }) {
    if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('Rate limit must be a positive integer.');
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1000) throw new Error('Rate-limit window must be at least 1000ms.');
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#maxKeys = options.maxKeys ?? 20_000;
    if (!Number.isInteger(this.#maxKeys) || this.#maxKeys < 1 || this.#maxKeys > 1_000_000) throw new Error('Rate-limit maxKeys is invalid.');
    this.#clock = options.clock ?? Date.now;
  }

  hit(keyInput: string): RateLimitDecision {
    const key = boundedKey(keyInput);
    const now = this.#clock();
    let entry = this.#entries.get(key);
    if (entry && now - entry.windowStartedAt >= this.#windowMs) {
      this.#entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      this.#evictForInsert();
      entry = { count: 0, windowStartedAt: now };
    }
    entry.count += 1;
    this.#touch(key, entry);
    const remaining = Math.max(0, this.#limit - entry.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.windowStartedAt + this.#windowMs - now) / 1000));
    return { allowed: entry.count <= this.#limit, remaining, retryAfterSeconds };
  }

  isLimited(keyInput: string): RateLimitDecision {
    const key = boundedKey(keyInput);
    const now = this.#clock();
    const entry = this.#entries.get(key);
    if (!entry || now - entry.windowStartedAt >= this.#windowMs) {
      if (entry) this.#entries.delete(key);
      return { allowed: true, remaining: this.#limit, retryAfterSeconds: 1 };
    }
    this.#touch(key, entry);
    return {
      allowed: entry.count < this.#limit,
      remaining: Math.max(0, this.#limit - entry.count),
      retryAfterSeconds: Math.max(1, Math.ceil((entry.windowStartedAt + this.#windowMs - now) / 1000))
    };
  }

  clear(keyInput: string): void {
    this.#entries.delete(boundedKey(keyInput));
  }

  get size(): number { return this.#entries.size; }

  #touch(key: string, entry: Entry): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  #evictForInsert(): void {
    if (this.#entries.size < this.#maxKeys) return;
    const oldest = this.#entries.keys().next().value as string | undefined;
    if (oldest !== undefined) this.#entries.delete(oldest);
  }
}

export function requestClientKey(request: http.IncomingMessage): string {
  const peer = normalizeIp(request.socket.remoteAddress ?? '');
  const forwarded = request.headers['x-forwarded-for'];
  if (isLoopback(peer) && typeof forwarded === 'string') {
    const first = normalizeIp(forwarded.split(',')[0]?.trim() ?? '');
    if (isIP(first)) return `ip:${first}`;
  }
  return `ip:${peer || 'unknown'}`;
}

export function principalRateKey(issuer: string, subject: string): string {
  return `principal:${crypto.createHash('sha256').update(JSON.stringify({ issuer, subject }), 'utf8').digest('base64url')}`;
}

function boundedKey(value: string): string {
  const text = String(value ?? '');
  if (!text || text.length > 512 || /[\0\r\n]/.test(text)) throw new Error('Rate-limit key is invalid.');
  return text;
}

function normalizeIp(input: string): string {
  const value = String(input ?? '').trim().toLowerCase();
  if (value.startsWith('::ffff:')) return value.slice(7);
  return value.replace(/^\[|\]$/g, '');
}

function isLoopback(input: string): boolean {
  return input === '127.0.0.1' || input === '::1' || input === 'localhost';
}

export function envRateLimit(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100_000) throw new Error(`${label} must be an integer between 1 and 100000.`);
  return parsed;
}
