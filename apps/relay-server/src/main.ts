import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { RelayHub } from './relay-hub.ts';
import { RelayResultService } from './result-service.ts';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;
const DEFAULT_RESULT_PORT = 8789;
const PUBLIC_BIND_ACK = 'TLS_TERMINATES_UPSTREAM';

export interface RelayServiceConfig {
  stateDir: string;
  host: string;
  port: number;
  resultHost: string;
  resultPort: number;
}

export function readRelayServiceConfig(env: NodeJS.ProcessEnv = process.env): RelayServiceConfig {
  const stateDir = path.resolve(env.OPERATOR_RELAY_STATE_DIR?.trim() || path.join(process.cwd(), '.operator-relay-state'));
  const host = (env.OPERATOR_RELAY_HOST?.trim() || DEFAULT_HOST).toLowerCase();
  const resultHost = (env.OPERATOR_RELAY_RESULT_HOST?.trim() || host).toLowerCase();
  const port = validPort(env.OPERATOR_RELAY_PORT, DEFAULT_PORT, 'OPERATOR_RELAY_PORT');
  const resultPort = validPort(env.OPERATOR_RELAY_RESULT_PORT, DEFAULT_RESULT_PORT, 'OPERATOR_RELAY_RESULT_PORT');
  if (port === resultPort && host === resultHost) throw new Error('Relay WebSocket and result service cannot bind the same host/port.');
  if ((!isLoopbackHost(host) || !isLoopbackHost(resultHost)) && env.OPERATOR_RELAY_PUBLIC_BIND_ACK !== PUBLIC_BIND_ACK) {
    throw new Error(`Non-loopback relay bind requires OPERATOR_RELAY_PUBLIC_BIND_ACK=${PUBLIC_BIND_ACK}; TLS must terminate at a trusted upstream proxy.`);
  }
  return { stateDir, host, port, resultHost, resultPort };
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

export async function runRelayResultService(config = readRelayServiceConfig()): Promise<RelayResultService> {
  const service = new RelayResultService({ stateDir: config.stateDir });
  const listening = await service.listen(config.resultHost, config.resultPort);
  process.stdout.write(JSON.stringify({
    service: 'operator-relay-results',
    status: 'listening',
    host: listening.host,
    port: listening.port,
    stateDir: config.stateDir,
    transport: isLoopbackHost(config.resultHost) ? 'local-http' : 'http-behind-required-tls-proxy'
  }) + '\n');
  return service;
}

async function main(): Promise<void> {
  const config = readRelayServiceConfig();
  const hub = await runRelayService(config);
  let resultService: RelayResultService;
  try {
    resultService = await runRelayResultService(config);
  } catch (error) {
    await hub.close();
    throw error;
  }
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    process.stdout.write(JSON.stringify({ service: 'operator-relay', status: 'stopping', signal }) + '\n');
    const settled = await Promise.allSettled([resultService.close(), hub.close()]);
    const failed = settled.find((entry) => entry.status === 'rejected');
    if (failed?.status === 'rejected') {
      process.stderr.write(`relay shutdown failed: ${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

function validPort(input: string | undefined, fallback: number, name: string): number {
  const text = input?.trim();
  const port = text === undefined || text === '' ? fallback : Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be an integer between 1 and 65535.`);
  return port;
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
