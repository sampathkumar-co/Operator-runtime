import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITY_RISK_RULES } from '../src/core/capability-policy.ts';
import { censusCurrentGitCheckout } from './wave0-provider-census.ts';

const TEST_ROOT = fileURLToPath(new URL('../test/', import.meta.url));
const MAX_TEST_FILES = 10_000;
const MAX_SINGLE_TEST_BYTES = 512 * 1024;

async function sourceTestReferences() {
  const pending = [TEST_ROOT];
  const paths: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile() && /\.test\.[cm]?[jt]s$/.test(entry.name)) {
        paths.push(full);
        if (paths.length > MAX_TEST_FILES) throw new Error('C00_TEST_INVENTORY_LIMIT_EXCEEDED');
      }
    }
  }
  paths.sort();
  const references: Array<{ path: string; source: string | null }> = [];
  let omittedOversize = 0;
  for (const full of paths) {
    const relative = path.relative(TEST_ROOT, full).split(path.sep).join('/');
    const stat = await fs.stat(full);
    if (stat.size > MAX_SINGLE_TEST_BYTES) {
      omittedOversize++;
      references.push({ path: relative, source: null });
    } else {
      references.push({ path: relative, source: await fs.readFile(full, 'utf8') });
    }
  }
  return { references, omittedOversize };
}

export async function buildC00SourceInventory() {
  const census = await censusCurrentGitCheckout();
  const { references, omittedOversize } = await sourceTestReferences();
  const operations = Object.entries(CAPABILITY_RISK_RULES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([capability, risk]) => {
      const declaredProviders = census.providers
        .filter(provider => provider.emptyInputDeclaredSupports.some(operation => operation.capability === capability))
        .map(provider => provider.name).sort();
      const unresolvedProbes = census.providers
        .filter(provider => provider.unresolvedEmptyInputProbes.some(operation => operation.capability === capability))
        .map(provider => provider.name).sort();
      const sourceTestHints = references
        .filter(ref => ref.source !== null && (ref.source.includes("'" + capability + "'")
          || ref.source.includes('"' + capability + '"')
          || ref.source.includes('`' + capability + '`')))
        .map(ref => ref.path);
      return {
        capability, canonicalRisk: risk, declaredProviders, unresolvedProbes,
        noPositiveEmptyInputProbe: declaredProviders.length === 0,
        sourceTestHints,
        sourceTestHintsStatus: 'SOURCE_REFERENCE_ONLY_NOT_INDEPENDENT_OUTCOME_PROOF',
        perOperationOutputVerification: 'NOT_CERTIFIED_BY_SOURCE_INVENTORY',
        actualOsSupport: 'NOT_PHYSICALLY_VERIFIED',
        authorizationAndUserOutcome: 'NOT_TESTED',
        ...(risk === 'dynamic' ? { riskResolution: 'TYPED_OPERATION_AND_FRESH_AUTHORITY_REQUIRED' } : {})
      };
    });
  return {
    schemaVersion: 1,
    sourceCommit: census.sourceCommit,
    providerRegistration: census.providers.map(p => ({
      name: p.name, sourceClass: p.class,
      emptyInputSupportedOperations: p.emptyInputDeclaredSupports.map(x => x.capability).sort(),
      emptyInputUnresolvedOperations: p.unresolvedEmptyInputProbes.map(x => x.capability).sort(),
      sourcePlatformLimitation: /windows|uia/i.test(p.class)
        ? 'WINDOWS_NATIVE_DEPENDENCY_DECLARED_NOT_TESTED'
        : 'CONFIGURATION_AND_OS_CAPABILITY_NOT_VERIFIED'
    })),
    declaredCanonicalCapabilityCount: operations.length,
    providerRegistrationCount: census.providers.length,
    scannedTestFileCount: references.length,
    oversizedTestFilesNotScanned: omittedOversize,
    operations,
    bounds: [
      'Source inventory only; an empty-input supports declaration is not an OS compatibility or user authorization grant.',
      'Test filename references are not assertions of passing tests or independent postconditions.',
      'The actual installed device, optional providers, cross-host authority and live browser behavior require separate evidence.',
      'A missing reference or false empty-input support result is NOT evidence that the capability is unsupported.'
    ],
    releaseAcceptance: 'NOT_ACCEPTED'
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const report = await buildC00SourceInventory();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
