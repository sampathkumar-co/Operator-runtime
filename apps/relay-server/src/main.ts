import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { RelayHub } from './relay-hub.ts';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;
const PUBLIC_BIND_ACK = 'TLS_TERMINATES_UPSTREAM';

export interface RelayServiceConfig {
  stateDir: string;
  host: string;
  port: number;
}

export function readRelayServiceConfig(env: NodeJS.ProcessEnv = process.env): RelayServiceConfig {
  const stateDir = path.resolve(env.OPERATOR_RELAY_STATE_DIR?.trim() || path.join(process.cwd(), '.operator-relay-state'));
  const host = (env.OPERATOR_RELAY_HOST?.trim() || DEFAULT_HOST).toLowerCase();
  const portText = env.OPERATOR_RELAY_PORT?.trim();
  const port = portText === undefined || portText === '' ? DEFAULT_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('OPERATOR_RELAY_PORT must be an integer between 1 and 65535.');
  }
  if (!isLoopbackHost(host) && env.OPERATOR_RELAY_PUBLIC_BIND_ACK !== PUBLIC_BIND_ACK) {
    throw new Error(`Non-loopback relay bind requires OPERATOR_RELAY_PUBLIC_BIND_ACK=${PUBLIC_BIND_ACK}; TLS must terminate at a trusted upstream proxy.`);
  }
  return { stateDir, host, port };
}

export async function runRelayService(config = readRelayServiceConfig()): Promise<RelayHub> {
  const hub = new RelayHub({ stateDir: config.stateDir });
  const listening = await hub.listen(config.host, config.port);
  process.stdout.write(JSON.stringify({
    service: 'operator-relay',
    status: 'listening',
    host: listening.host,
    port: listening.port,
    stateDir: config.stateDir,
    transport: isLoopbackHost(config.host) ? 'local-plain-websocket' : 'plain-websocket-behind-required-tls-proxy'
  }) + '\n');
  return hub;
}

async function main(): Promise<void> {
  const hub = await runRelayService();
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    process.stdout.write(JSON.stringify({ service: 'operator-relay', status: 'stopping', signal }) + '\n');
    try {
      await hub.close();
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(`relay shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

function isLoopbackHost(hostInput: string): boolean {
  const host = hostInput.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`relay startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
