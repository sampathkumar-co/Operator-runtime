import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPublicMcpEdgeConfig, resolveMcpBindHost } from '../src/public-edge.ts';
import { loadPublicServicePages, PUBLIC_SERVICE_PAGE_PATHS } from '../src/public-pages.ts';
import { oauthProviderConfigFromEnv, runOAuthProviderPreflight } from './oauth-provider-preflight.ts';

const PLACEHOLDER = /(?:^replace-with-|^required[_-]|your-domain|example\.(?:com|net|org)|\.invalid\b)/i;
const REQUIRED_SECRET_NAMES = ['OPERATOR_RELAY_CONTROL_TOKEN'] as const;

export interface ProductionEdgePreflightOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

export async function runProductionEdgePreflight(
  options: ProductionEdgePreflightOptions = {}
): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  requireProductionSecrets(env);
  loadPublicServicePages(env);
  const edge = readPublicMcpEdgeConfig(env, { fetchFn: options.fetchFn });
  if (!edge) throw new Error('Production edge preflight requires OPERATOR_MCP_PUBLIC_EDGE=1.');
  const bindHost = resolveMcpBindHost(env, edge);
  const providerConfig = oauthProviderConfigFromEnv(env);
  providerConfig.registrationMode = edge.oauthRegistrationMode;
  const provider = await runOAuthProviderPreflight(providerConfig, { fetchFn: options.fetchFn });

  return {
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    status: 'PASS',
    publicMcpUrl: edge.publicUrl.toString(),
    bindHost,
    allowedHostnames: edge.allowedHostnames,
    reviewerPages: [...PUBLIC_SERVICE_PAGE_PATHS],
    oauth: provider,
    externalGates: {
      tlsDnsReachability: 'REQUIRES_DEPLOYED_EDGE',
      realChatGPTAuthorization: 'REQUIRES_PLUGIN_CONNECTION'
    }
  };
}

function requireProductionSecrets(env: NodeJS.ProcessEnv): void {
  for (const name of REQUIRED_SECRET_NAMES) {
    const value = required(env, name);
    if (PLACEHOLDER.test(value)) throw new Error(`${name} still contains a deployment placeholder.`);
  }
  for (const name of ['OPERATOR_OAUTH_READ_SCOPE', 'OPERATOR_OAUTH_WRITE_SCOPE']) {
    const value = env[name]?.trim();
    if (value && PLACEHOLDER.test(value)) throw new Error(`${name} still contains a deployment placeholder.`);
  }
  const challengeToken = env.OPENAI_APPS_CHALLENGE_TOKEN?.trim();
  if (challengeToken && PLACEHOLDER.test(challengeToken)) {
    throw new Error('OPENAI_APPS_CHALLENGE_TOKEN still contains a deployment placeholder.');
  }
  const relayToken = required(env, 'OPERATOR_RELAY_CONTROL_TOKEN');
  if (Buffer.byteLength(relayToken, 'utf8') < 32) {
    throw new Error('OPERATOR_RELAY_CONTROL_TOKEN must be at least 32 bytes.');
  }
  const verificationMode = required(env, 'OPERATOR_OAUTH_VERIFICATION_MODE');
  if (verificationMode !== 'jwks' && verificationMode !== 'introspection') {
    throw new Error('OPERATOR_OAUTH_VERIFICATION_MODE must be jwks or introspection.');
  }
  const urls = ['OPERATOR_MCP_PUBLIC_URL', 'OPERATOR_OAUTH_ISSUER', 'OPERATOR_OAUTH_AUTHORIZATION_URL', 'OPERATOR_OAUTH_TOKEN_URL'];
  urls.push(verificationMode === 'jwks' ? 'OPERATOR_OAUTH_JWKS_URL' : 'OPERATOR_OAUTH_INTROSPECTION_URL');
  for (const name of urls) {
    if (PLACEHOLDER.test(required(env, name))) throw new Error(`${name} still contains a deployment placeholder.`);
  }
  if (verificationMode === 'introspection') {
    for (const name of ['OPERATOR_OAUTH_INTROSPECTION_CLIENT_ID', 'OPERATOR_OAUTH_INTROSPECTION_CLIENT_SECRET']) {
      const value = required(env, name);
      if (PLACEHOLDER.test(value)) throw new Error(`${name} still contains a deployment placeholder.`);
    }
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for production edge certification.`);
  return value;
}

const isEntrypoint = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  const receipt = await runProductionEdgePreflight();
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
