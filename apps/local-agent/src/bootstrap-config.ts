import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsDpapiProtector } from '../../../src/core/device-identity.ts';
import type { DeviceSecretProtector } from '../../../src/core/device-identity.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { readDurableStateText, writeDurableStateText } from '../../../src/core/durable-state.ts';
import { requireLiteralLoopbackBindHost } from '../../../src/core/network-authority.ts';

const CONFIG_VERSION = 1 as const;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_ROOTS = 32;
const DEFAULT_AGENT_PORT = 47_100;
const DEFAULT_MCP_PORT = 47_200;

type StoredBootstrapConfig = {
  version: typeof CONFIG_VERSION;
  configuredAt: string;
  allowedRoots: string[];
  agent: { host: string; port: number };
  mcp: { host: string; port: number };
  secretProtection: { scheme: 'windows-dpapi-current-user'; ciphertextBase64: string };
};

export interface ResolvedBootstrapConfig {
  stateDir: string;
  configuredAt: string;
  allowedRoots: string[];
  agentHost: string;
  agentPort: number;
  mcpHost: string;
  mcpPort: number;
  agentToken: string;
  recoveryToken: string;
}

export class BootstrapConfigStore {
  #stateDir: string;
  #file: string;
  #protector: DeviceSecretProtector;

  constructor(stateDir: string, protector: DeviceSecretProtector) {
    this.#stateDir = path.resolve(stateDir);
    this.#file = path.join(this.#stateDir, 'bootstrap.json');
    this.#protector = protector;
  }

  async configure(rootInput: string): Promise<ResolvedBootstrapConfig> {
    const root = await canonicalDirectory(rootInput);
    let existing: ResolvedBootstrapConfig | null = null;
    try { existing = await this.load(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const configuredAt = existing?.configuredAt ?? new Date().toISOString();
    const agentToken = existing?.agentToken ?? randomSecret();
    const recoveryToken = existing?.recoveryToken ?? randomSecret();
    const protectedBytes = await this.#protectSecrets(agentToken, recoveryToken);
    const stored: StoredBootstrapConfig = {
      version: CONFIG_VERSION,
      configuredAt,
      allowedRoots: [root],
      agent: { host: '127.0.0.1', port: existing?.agentPort ?? DEFAULT_AGENT_PORT },
      mcp: { host: '127.0.0.1', port: existing?.mcpPort ?? DEFAULT_MCP_PORT },
      secretProtection: { scheme: this.#protector.scheme, ciphertextBase64: protectedBytes.toString('base64') }
    };

    try {
      await writeDurableStateText(this.#file, JSON.stringify(stored, null, 2), {
        maxBytes: MAX_CONFIG_BYTES,
        errorCode: 'BOOTSTRAP_CONFIG_INVALID',
        invalidMessage: 'Operator bootstrap configuration is invalid.'
      });
    } finally {
      protectedBytes.fill(0);
    }
    return storedToResolved(this.#stateDir, stored, agentToken, recoveryToken);
  }

  async load(): Promise<ResolvedBootstrapConfig> {
    const text = await readDurableStateText(this.#file, {
      maxBytes: MAX_CONFIG_BYTES,
      errorCode: 'BOOTSTRAP_CONFIG_INVALID',
      invalidMessage: 'Operator bootstrap configuration is invalid.'
    });
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { throw new OperatorError('BOOTSTRAP_CONFIG_INVALID', 'Operator bootstrap configuration is not valid JSON.'); }
    const stored = validateStored(parsed);
    const ciphertext = Buffer.from(stored.secretProtection.ciphertextBase64, 'base64');
    let plaintext: Buffer | undefined;
    try {
      plaintext = await this.#protector.unprotect(ciphertext);
      const secrets = validateSecrets(JSON.parse(plaintext.toString('utf8')));
      return storedToResolved(this.#stateDir, stored, secrets.agentToken, secrets.recoveryToken);
    } finally {
      ciphertext.fill(0);
      plaintext?.fill(0);
    }
  }

  async #protectSecrets(agentToken: string, recoveryToken: string): Promise<Buffer> {
    const plaintext = Buffer.from(JSON.stringify({ agentToken, recoveryToken }), 'utf8');
    try { return await this.#protector.protect(plaintext); }
    finally { plaintext.fill(0); }
  }
}

export function defaultOperatorStateDir(): string {
  return path.resolve(process.env.OPERATOR_STATE_DIR ?? path.join(os.homedir(), '.operator'));
}

export function windowsBootstrapProtector(): DeviceSecretProtector {
  if (process.platform !== 'win32') {
    throw new OperatorError('BOOTSTRAP_WINDOWS_REQUIRED', 'One-command protected setup is currently supported by the Windows release.');
  }
  const helper = process.env.OPERATOR_WINDOWS_DPAPI_PATH;
  if (!helper || !path.isAbsolute(helper)) {
    throw new OperatorError('WINDOWS_DPAPI_HELPER_REQUIRED', 'Packaged Windows DPAPI helper is required for Operator setup.');
  }
  return new WindowsDpapiProtector(helper);
}

export function applyBootstrapEnvironment(config: ResolvedBootstrapConfig): void {
  process.env.OPERATOR_STATE_DIR = config.stateDir;
  process.env.OPERATOR_ALLOWED_ROOTS = config.allowedRoots.join(path.delimiter);
  process.env.OPERATOR_AGENT_TOKEN = config.agentToken;
  process.env.OPERATOR_RECOVERY_TOKEN = config.recoveryToken;
  process.env.OPERATOR_AGENT_HOST = config.agentHost;
  process.env.OPERATOR_AGENT_PORT = String(config.agentPort);
  process.env.OPERATOR_AGENT_URL = `http://${formatHost(config.agentHost)}:${config.agentPort}`;
  process.env.OPERATOR_MCP_HOST = config.mcpHost;
  process.env.OPERATOR_MCP_PORT = String(config.mcpPort);
}

async function canonicalDirectory(input: string): Promise<string> {
  const resolved = path.resolve(input);
  let stat;
  try { stat = await fs.stat(resolved); }
  catch { throw new OperatorError('BOOTSTRAP_ROOT_INVALID', `Authorized root does not exist: ${resolved}`); }
  if (!stat.isDirectory()) throw new OperatorError('BOOTSTRAP_ROOT_INVALID', `Authorized root is not a directory: ${resolved}`);
  return await fs.realpath(resolved);
}

function randomSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function validPort(input: unknown, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 65_535) {
    throw new OperatorError('BOOTSTRAP_CONFIG_INVALID', `${label} must be an integer port from 1024 through 65535.`);
  }
  return value;
}

function validConfiguredAt(input: unknown): string {
  const value = String(input ?? '');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new OperatorError('BOOTSTRAP_CONFIG_INVALID', 'Bootstrap configuredAt must be an ISO timestamp.');
  }
  return value;
}

function validateStored(input: unknown): StoredBootstrapConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('BOOTSTRAP_CONFIG_INVALID', 'Bootstrap configuration must be a JSON object.');
  }
  const value = input as Record<string, unknown>;
  if (value.version !== CONFIG_VERSION) throw new OperatorError('BOOTSTRAP_CONFIG_INVALID', 'Unsupported bootstrap configuration version.');
  if (!Array.isArray(value.allowedRoots) || value.allowedRoots.length < 1 || value.allowedRoots.length > MAX_ROOTS) {
    throw new OperatorError('BOOTSTRAP_CONFIG_INVALID', `Bootstrap configuration must contain 1-${MAX_ROOTS} authorized roots.`);
  }
  const allowedRoots = value.allowedRoots.map((root) => {
    const candidate = String(root ?? '');
    if (!candidate || !path.isAbsolute(candidate)) throw new OperatorError('BOOTSTRAP_CONFIG_INVALID', 'Authorized roots must be absolute paths.');
    return path.resolve(candidate);
  });
  if (new Set(allowedRoots.map((root) => process.platform === 'win32' ? root.toLowerCase() : root)).size !== allowedRoots.length) {
    throw new OperatorError('BOOTSTRAP_CONFIG_INVALID', 'Authorized roots must be unique.');
  }
  const agent = validEndpoint(value.agent, 'Local agent');
  const mcp = validEndpoint(value.mcp, 'MCP server');
  const protection = value.secretProtection as Record<string, unknown> | undefined;
  if (!protection || protection.scheme !== 'windows-dpapi-current-user') {
    throw new OperatorError('BOOTSTRAP_CONFIG_INVALID', 'Bootstrap secrets must use Windows DPAPI CurrentUser protection.');
  }
  const ciphertextBase64 = String(protection.ciphertextBase64 ?? '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertextBase64) || ciphertextBase64.length > 128 * 1024) {
    throw new OperatorError('BOOTSTRAP_CONFIG_INVALID', 'Bootstrap secret ciphertext is invalid.');
  }
  return {
    version: CONFIG_VERSION,
    configuredAt: validConfiguredAt(value.configuredAt),
    allowedRoots,
    agent,
    mcp,
    secretProtection: { scheme: 'windows-dpapi-current-user', ciphertextBase64 }
  };
}

function validEndpoint(input: unknown, label: string): { host: string; port: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('BOOTSTRAP_CONFIG_INVALID', `${label} endpoint is invalid.`);
  }
  const value = input as Record<string, unknown>;
  return {
    host: requireLiteralLoopbackBindHost(String(value.host ?? ''), label),
    port: validPort(value.port, `${label} port`)
  };
}

function validateSecrets(input: unknown): { agentToken: string; recoveryToken: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('BOOTSTRAP_SECRET_INVALID', 'Protected bootstrap secret payload is invalid.');
  }
  const value = input as Record<string, unknown>;
  const agentToken = validSecret(value.agentToken, 'agent token');
  const recoveryToken = validSecret(value.recoveryToken, 'recovery token');
  return { agentToken, recoveryToken };
}

function validSecret(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (value.length < 32 || Buffer.byteLength(value, 'utf8') > 4096) {
    throw new OperatorError('BOOTSTRAP_SECRET_INVALID', `Protected ${label} is invalid.`);
  }
  return value;
}

function storedToResolved(
  stateDir: string,
  stored: StoredBootstrapConfig,
  agentToken: string,
  recoveryToken: string
): ResolvedBootstrapConfig {
  return {
    stateDir,
    configuredAt: stored.configuredAt,
    allowedRoots: [...stored.allowedRoots],
    agentHost: stored.agent.host,
    agentPort: stored.agent.port,
    mcpHost: stored.mcp.host,
    mcpPort: stored.mcp.port,
    agentToken,
    recoveryToken
  };
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}
