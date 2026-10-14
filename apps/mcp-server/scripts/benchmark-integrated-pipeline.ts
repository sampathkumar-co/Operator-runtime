import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AccountDeviceRegistry } from '../../../src/core/account-device-registry.ts';
import { AuditLog } from '../../../src/core/audit.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore, answerPairingChallenge } from '../../../src/core/device-registry.ts';
import { pipelineLatency, summarizePipelineSpans, type PipelineSpan } from '../../../src/core/pipeline-latency.ts';
import { RelayDeliveryStore } from '../../../src/core/relay-delivery-store.ts';
import { RelayResultStore } from '../../../src/core/relay-result-store.ts';
import { DeviceSessionTokenStore } from '../../../src/core/session-token.ts';
import { createRuntime } from '../../local-agent/src/runtime-factory.ts';
import { LocalAgentRelayRunner } from '../../local-agent/src/relay-agent.ts';
import { createLocalAgentServer } from '../../local-agent/src/server.ts';
import { RelayControlService } from '../../relay-server/src/control-service.ts';
import { RelayHub } from '../../relay-server/src/relay-hub.ts';
import { RelayResultService } from '../../relay-server/src/result-service.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const MCP_ROOT = path.resolve(import.meta.dirname, '..');
const CONTROL_TOKEN = 'isolated-relay-control-token-0123456789abcdef';
const AGENT_TOKEN = 'a'.repeat(64);
const INTERNAL_TOKEN = 'r'.repeat(64);
const repetitions = boundedInt(process.env.MECORD_BENCH_REPS, 1000, 1, 10_000);
const requestedConcurrency = parseConcurrency(process.env.MECORD_BENCH_CONCURRENCY ?? '1,5,10,25,50,100');
const concurrencyRuns = requestedConcurrency.filter((value) => value <= 16);
const unsupportedConcurrency = requestedConcurrency.filter((value) => value > 16).map((value) => ({
  concurrency: value,
  tested: false,
  reason: 'exceeds the relay result service bounded 16-read out-of-order persistence window'
}));
const concurrencySamples = boundedInt(process.env.MECORD_BENCH_CONCURRENCY_SAMPLES, 100, 1, 10_000);
const sourceSha = sourceIdentity();
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.resolve(process.env.MECORD_BENCH_OUTPUT_DIR ?? path.join(ROOT, 'artifacts', `pipeline-integrated-${runId}`));
const hostedSnapshot = path.join(outputDir, 'hosted-snapshot.json');
const cleanup: Array<() => Promise<unknown> | unknown> = [];

await fs.mkdir(outputDir, { recursive: true });
const authorityState = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-pipeline-authority-'));
const deviceState = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-pipeline-device-'));
const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-pipeline-project-'));
cleanup.push(() => fs.rm(authorityState, { recursive: true, force: true }));
cleanup.push(() => fs.rm(deviceState, { recursive: true, force: true }));
cleanup.push(() => fs.rm(projectRoot, { recursive: true, force: true }));

let mcp: ChildProcess | undefined;
let client: Client | undefined;
let runner: LocalAgentRelayRunner | undefined;
let runnerRun: Promise<void> | undefined;

try {
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const authority = await authorityIdentity.loadOrCreate('Isolated Relay Authority');
  const device = await deviceIdentity.loadOrCreate('Isolated Benchmark Device');
  const challenge = await devices.issuePairingChallenge(authority, { expectedPeerDeviceId: device.deviceId, ttlMs: 60_000 });
  await devices.completePairing(await answerPairingChallenge(challenge, deviceIdentity));
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices);
  const deliveries = new RelayDeliveryStore(authorityState);
  const results = new RelayResultStore(authorityState);
  const account = await accounts.resolveOrCreateAccount({ issuer: 'mecord-isolated-benchmark', subject: sourceSha });
  await accounts.bindDevice(account.accountId, device.deviceId);

  const hub = new RelayHub({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts, deliveries });
  const resultService = new RelayResultService({
    stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts, deliveries, results,
    requestLimitPerMinute: 100_000, deviceLimitPerMinute: 100_000
  });
  const controlService = new RelayControlService({ hub, results, accounts, token: CONTROL_TOKEN });
  cleanup.push(() => controlService.close());
  cleanup.push(() => resultService.close());
  cleanup.push(() => hub.close());
  const hubBound = await hub.listen('127.0.0.1', 0);
  const resultBound = await resultService.listen('127.0.0.1', 0);
  const controlBound = await controlService.listen('127.0.0.1', 0);

  const token = (await sessions.issue({
    subjectDeviceId: device.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'relay:result', 'cap:computer.inspect'],
    ttlMs: 30 * 60_000
  })).token;
  const tokenFile = path.join(deviceState, 'relay-session.token');
  await fs.writeFile(tokenFile, `${token}\n`, { mode: 0o600 });

  const runtime = createRuntime({ allowedRoots: [projectRoot], allowedExecutables: ['node'], browserAutoLaunch: false });
  const audit = new AuditLog(deviceState);
  const agent = createLocalAgentServer({
    runtime,
    token: AGENT_TOKEN,
    relayInternalToken: INTERNAL_TOKEN,
    audit,
    permissions: {
      allowedCapabilities: ['computer.inspect'],
      allowedRoots: [projectRoot],
      allowExternalWrites: false,
      allowSystemChanges: false,
      allowDestructive: false
    }
  });
  cleanup.push(() => runtime.close());
  cleanup.push(() => agent.close());
  const agentBound = await agent.listen('127.0.0.1', 0);

  runner = new LocalAgentRelayRunner({
    stateDir: deviceState,
    relayUrl: `ws://127.0.0.1:${hubBound.port}/device`,
    resultUrl: `http://127.0.0.1:${resultBound.port}/v1/device-result`,
    sessionTokenFile: tokenFile,
    identity: deviceIdentity,
    localAgentBaseUrl: `http://127.0.0.1:${agentBound.port}`,
    agentToken: AGENT_TOKEN,
    relayInternalToken: INTERNAL_TOKEN,
    supportedCapabilities: ['computer.inspect'],
    allowLoopbackInsecure: true
  });
  runnerRun = runner.run();
  await waitFor(async () => (await hub.onlineDevices(account.accountId)).some((entry) => entry.deviceId === device.deviceId));

  const mcpPort = await reservePort();
  let mcpStderr = '';
  mcp = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: MCP_ROOT,
    env: {
      ...process.env,
      OPERATOR_EXECUTION_MODE: 'relay',
      OPERATOR_AGENT_TOKEN: CONTROL_TOKEN,
      OPERATOR_RELAY_CONTROL_TOKEN: CONTROL_TOKEN,
      OPERATOR_RELAY_CONTROL_URL: `http://127.0.0.1:${controlBound.port}`,
      OPERATOR_RELAY_ACCOUNT_ID: account.accountId,
      OPERATOR_RELAY_DEVICE_ID: device.deviceId,
      OPERATOR_RELAY_PROJECT_KEY: 'isolated-benchmark',
      OPERATOR_MCP_HOST: '127.0.0.1',
      OPERATOR_MCP_PORT: String(mcpPort),
      OPERATOR_PIPELINE_TRACE_ENABLED: '1',
      OPERATOR_PIPELINE_TRACE_CAPACITY: '65536',
      OPERATOR_PIPELINE_TRACE_EXPORT_PATH: hostedSnapshot,
      OPERATOR_PIPELINE_TRACE_EXPORT_INTERVAL_MS: '5000',
      OPERATOR_SOURCE_SHA: sourceSha,
      OPERATOR_RUNTIME_VERSION: process.version,
      OPERATOR_PIPELINE_MACHINE_LABEL: 'isolated-hosted-mcp'
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  });
  mcp.stderr?.setEncoding('utf8');
  mcp.stderr?.on('data', (chunk: string) => { mcpStderr = `${mcpStderr}${chunk}`.slice(-16_000); });
  await waitForHealth(`http://127.0.0.1:${mcpPort}/health`, mcp, () => mcpStderr);

  client = new Client({ name: 'mecord-integrated-pipeline-benchmark', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`)));
  const warmup = await client.callTool({ name: 'computer.inspect', arguments: {} });
  assert.notEqual(warmup.isError, true, 'warmup computer.inspect failed');

  const sequential = await executeBatch(client, repetitions, 1);
  await fs.writeFile(path.join(outputDir, 'sequential-checkpoint.json'), `${JSON.stringify({
    schemaVersion: 1, sourceSha, generatedAt: new Date().toISOString(), sequential
  }, null, 2)}\n`, { mode: 0o600 });
  const concurrency: Record<string, BatchResult> = {};
  for (const width of concurrencyRuns) concurrency[String(width)] = await executeBatch(client, concurrencySamples, width);

  // The hosted process exports asynchronously; wait for one final bounded snapshot.
  await waitFor(async () => await exists(hostedSnapshot), 8_000);
  await new Promise((resolve) => setTimeout(resolve, 5_250));
  const hosted = JSON.parse(await fs.readFile(hostedSnapshot, 'utf8')) as { droppedSpans: number; spans: PipelineSpan[] };
  const localSpans = pipelineLatency.snapshot();
  const allSpans = [...hosted.spans, ...localSpans];
  const metadata = {
    sourceSha,
    runtimeVersion: process.version,
    operatingSystem: `${os.type()} ${os.release()}`,
    chromeVersion: 'not-applicable',
    machine: 'Sampath isolated integrated loopback staging',
    conditions: `real MCP, relay control, durable relay, WebSocket, paired local runtime; sequential=${repetitions}`
  };
  const stageReport = summarizePipelineSpans(allSpans, metadata, hosted.droppedSpans + pipelineLatency.droppedSpans);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceSha,
    node: process.version,
    nodeSha256: await sha256File(process.execPath),
    platform: { platform: process.platform, arch: process.arch, release: os.release() },
    environment: 'isolated source-matched loopback staging; no production credentials or state',
    sequential,
    concurrency,
    unsupportedConcurrency,
    tracing: { retainedSpans: allSpans.length, droppedSpans: stageReport.droppedSpans },
    stageReport
  };
  await fs.writeFile(path.join(outputDir, 'benchmark-results.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(outputDir, 'benchmark-stage-latency.csv'), stageCsv(stageReport.stages), { mode: 0o600 });
  process.stdout.write(`MECORD_INTEGRATED_BENCHMARK_DIR=${outputDir}\n`);
  process.stdout.write(`MECORD_INTEGRATED_SUMMARY=${JSON.stringify({ sourceSha, sequential: withoutSamples(sequential), concurrency: Object.fromEntries(Object.entries(concurrency).map(([key, value]) => [key, withoutSamples(value)])), unsupportedConcurrency, retainedSpans: allSpans.length, droppedSpans: stageReport.droppedSpans })}\n`);
} finally {
  if (client) await client.close().catch(() => undefined);
  if (mcp) await stopChild(mcp);
  if (runner) runner.stop();
  if (runnerRun) await runnerRun.catch(() => undefined);
  for (const close of cleanup.reverse()) await close();
}

type BatchResult = {
  n: number; concurrency: number; succeeded: number; failures: number; throughputPerSecond: number;
  minMs: number; meanMs: number; p50Ms: number; p90Ms: number; p95Ms: number; p99Ms: number; maxMs: number;
  localExecution: { n: number; meanMs: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
  samplesMs: number[];
};

async function executeBatch(client: Client, count: number, concurrency: number): Promise<BatchResult> {
  const samples = new Array<number>(count);
  const local: number[] = [];
  let succeeded = 0;
  let next = 0;
  const began = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (true) {
      const index = next++;
      if (index >= count) return;
      const started = performance.now();
      const response = await client.callTool({ name: 'computer.inspect', arguments: {} });
      samples[index] = performance.now() - started;
      if (response.isError === true) continue;
      const content = response.structuredContent as Record<string, unknown>;
      assert.equal(content.capability, 'computer.inspect');
      assert.equal(typeof content.durationMs, 'number');
      local.push(Number(content.durationMs));
      succeeded++;
    }
  }));
  const elapsedMs = performance.now() - began;
  const stats = distribution(samples);
  const localStats = distribution(local);
  return {
    n: count,
    concurrency,
    succeeded,
    failures: count - succeeded,
    throughputPerSecond: +(count / (elapsedMs / 1000)).toFixed(3),
    ...stats,
    localExecution: { n: local.length, meanMs: localStats.meanMs, p50Ms: localStats.p50Ms, p95Ms: localStats.p95Ms, p99Ms: localStats.p99Ms, maxMs: localStats.maxMs },
    samplesMs: samples.map((value) => +value.toFixed(3))
  };
}

function distribution(values: number[]) {
  if (values.length === 0) return { minMs: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
  return {
    minMs: +sorted[0]!.toFixed(3),
    meanMs: +(sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(3),
    p50Ms: +q(.5).toFixed(3), p90Ms: +q(.9).toFixed(3), p95Ms: +q(.95).toFixed(3), p99Ms: +q(.99).toFixed(3),
    maxMs: +sorted.at(-1)!.toFixed(3)
  };
}

function withoutSamples(value: BatchResult): Omit<BatchResult, 'samplesMs'> {
  const { samplesMs: _, ...summary } = value;
  return summary;
}

function stageCsv(stages: ReturnType<typeof summarizePipelineSpans>['stages']): string {
  const header = ['origin','stage','count','succeeded','successRate','meanMs','minMs','p50Ms','p95Ms','p99Ms','maxMs','sumMs','networkRoundTrips','retries','reconnects','timeouts'];
  const rows = stages.map((stage) => header.map((key) => JSON.stringify((stage as unknown as Record<string, unknown>)[key] ?? '')).join(','));
  return `${header.join(',')}\n${rows.join('\n')}\n`;
}

async function reservePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback port unavailable');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not satisfied within ${timeoutMs} ms`);
}

async function waitForHealth(url: string, child: ChildProcess, stderr: () => string): Promise<void> {
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`MCP server exited before health: ${stderr()}`);
    try { return (await fetch(url, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
  }, 15_000);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function boundedInt(input: string | undefined, fallback: number, min: number, max: number): number {
  const value = input === undefined ? fallback : Number(input);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`benchmark integer must be ${min}-${max}`);
  return value;
}

function parseConcurrency(input: string): number[] {
  if (!input.trim()) return [];
  const values = input.split(',').map((value) => boundedInt(value.trim(), 1, 1, 100));
  return [...new Set(values)];
}

function sourceIdentity(): string {
  const supplied = process.env.MECORD_BENCH_SHA?.trim();
  if (supplied && /^[0-9a-f]{40}$/i.test(supplied)) return supplied.toLowerCase();
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim().toLowerCase();
}

async function sha256File(file: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}
