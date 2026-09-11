import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { AccountDeviceRegistry } from '../../../src/core/account-device-registry.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore } from '../../../src/core/device-registry.ts';
import { RelayDeliveryStore } from '../../../src/core/relay-delivery-store.ts';
import { RelayResultStore } from '../../../src/core/relay-result-store.ts';
import { DeviceSessionTokenStore } from '../../../src/core/session-token.ts';
import { RelayControlService } from './control-service.ts';
import { RelayHub } from './relay-hub.ts';
import { RelayResultService } from './result-service.ts';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;
const DEFAULT_RESULT_PORT = 8789;
const DEFAULT_CONTROL_PORT = 8790;
const CONTROL_HOST = '127.0.0.1';
const PUBLIC_BIND_ACK = 'TLS_TERMINATES_UPSTREAM';

export interface RelayServiceConfig {
  stateDir: string;
  host: string;
  port: number;
  resultHost: string;
  resultPort: number;
  controlHost: typeof CONTROL_HOST;
  controlPort: number;
  controlToken?: string;
}

export function readRelayServiceConfig(env: NodeJS.ProcessEnv = process.env): RelayServiceConfig {
  const stateDir = path.resolve(env.OPERATOR_RELAY_STATE_DIR?.trim() || path.join(process.cwd(), '.operator-relay-state'));
  const host = (env.OPERATOR_RELAY_HOST?.trim() || DEFAULT_HOST).toLowerCase();
  const resultHost = (env.OPERATOR_RELAY_RESULT_HOST?.trim() || host).toLowerCase();
  const port = validPort(env.OPERATOR_RELAY_PORT, DEFAULT_PORT, 'OPERATOR_RELAY_PORT');
  const resultPort = validPort(env.OPERATOR_RELAY_RESULT_PORT, DEFAULT_RESULT_PORT, 'OPERATOR_RELAY_RESULT_PORT');
  const controlPort = validPort(env.OPERATOR_RELAY_CONTROL_PORT, DEFAULT_CONTROL_PORT, 'OPERATOR_RELAY_CONTROL_PORT');
  const controlToken = env.OPERATOR_RELAY_CONTROL_TOKEN?.trim();
  if (controlToken !== undefined && controlToken.length < 32) throw new Error('OPERATOR_RELAY_CONTROL_TOKEN must be at least 32 characters when set.');
  if (port === resultPort && host === resultHost) throw new Error('Relay WebSocket and result service cannot bind the same host/port.');
  if (controlPort === port || controlPort === resultPort) throw new Error('OPERATOR_RELAY_CONTROL_PORT must be distinct from relay delivery and result ports.');
  if ((!isLoopbackHost(host) || !isLoopbackHost(resultHost)) && env.OPERATOR_RELAY_PUBLIC_BIND_ACK !== PUBLIC_BIND_ACK) {
    throw new Error(`Non-loopback relay bind requires OPERATOR_RELAY_PUBLIC_BIND_ACK=${PUBLIC_BIND_ACK}; TLS must terminate at a trusted upstream proxy.`);
  }
  return { stateDir, host, port, resultHost, resultPort, controlHost: CONTROL_HOST, controlPort, controlToken };
}

export async function runRelayService(config = readRelayServiceConfig()): Promise<RelayHub> {
  const hub = new RelayHub({ stateDir: config.stateDir });
  const listening = await hub.listen(config.host, config.port);
  logListening('operator-relay', listening.host, listening.port, config.stateDir, isLoopbackHost(config.host) ? 'local-plain-websocket' : 'plain-websocket-behind-required-tls-proxy');
  return hub;
}

export async function runRelayResultService(config = readRelayServiceConfig()): Promise<RelayResultService> {
  const service = new RelayResultService({ stateDir: config.stateDir });
  const listening = await service.listen(config.resultHost, config.resultPort);
  logListening('operator-relay-results', listening.host, listening.port, config.stateDir, isLoopbackHost(config.resultHost) ? 'local-http' : 'http-behind-required-tls-proxy');
  return service;
}

async function main(): Promise<void> {
  const config = readRelayServiceConfig();
  const identity = new DeviceIdentityStore(config.stateDir);
  const devices = new DeviceRegistryStore(config.stateDir);
  const sessions = new DeviceSessionTokenStore(config.stateDir, identity, devices);
  const accounts = new AccountDeviceRegistry(config.stateDir, devices);
  const deliveries = new RelayDeliveryStore(config.stateDir);
  const results = new RelayResultStore(config.stateDir);

  const hub = new RelayHub({ stateDir: config.stateDir, identity, devices, sessions, accounts, deliveries });
  const resultService = new RelayResultService({ stateDir: config.stateDir, identity, devices, sessions, deliveries, results });
  let controlService: RelayControlService | null = null;

  try {
    const hubListening = await hub.listen(config.host, config.port);
    logListening('operator-relay', hubListening.host, hubListening.port, config.stateDir, isLoopbackHost(config.host) ? 'local-plain-websocket' : 'plain-websocket-behind-required-tls-proxy');
    const resultListening = await resultService.listen(config.resultHost, config.resultPort);
    logListening('operator-relay-results', resultListening.host, resultListening.port, config.stateDir, isLoopbackHost(config.resultHost) ? 'local-http' : 'http-behind-required-tls-proxy');
    if (config.controlToken) {
      controlService = new RelayControlService({ hub, results, accounts, token: config.controlToken });
      const controlListening = await controlService.listen(config.controlHost, config.controlPort);
      logListening('operator-relay-control', controlListening.host, controlListening.port, config.stateDir, 'internal-loopback-http');
    } else {
      process.stdout.write(JSON.stringify({ service: 'operator-relay-control', status: 'disabled', reason: 'OPERATOR_RELAY_CONTROL_TOKEN not configured' }) + '\n');
    }
  } catch (error) {
    await Promise.allSettled([controlService?.close(), resultService.close(), hub.close()].filter(Boolean) as Array<Promise<unknown>>);
    throw error;
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    process.stdout.write(JSON.stringify({ service: 'operator-relay', status: 'stopping', signal }) + '\n');
    const settled = await Promise.allSettled([controlService?.close(), resultService.close(), hub.close()].filter(Boolean) as Array<Promise<unknown>>);
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

function logListening(service: string, host: string, port: number, stateDir: string, transport: string): void {
  process.stdout.write(JSON.stringify({ service, status: 'listening', host, port, stateDir, transport }) + '\n');
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
