export const RELEASE_TRUTH_SCHEMA_VERSION = 1 as const;

export const RELEASE_TRUTH = Object.freeze({
  schemaVersion: RELEASE_TRUTH_SCHEMA_VERSION,
  product: Object.freeze({
    name: 'mecord-connect',
    title: 'Mecord Connect',
    publicSurfaceVersion: '1.0.0'
  }),
  source: Object.freeze({
    repository: 'sampathkumar-co/Operator-runtime',
    runtimePackageVersion: '2.0.4',
    bootstrapPackageVersion: '1.0.0'
  }),
  production: Object.freeze({
    statusDate: '2026-09-28',
    sourceCommit: 'b73d699f3cdca4d6e372942f626012fb4909068b',
    publicSurfaceVersion: '1.0.0',
    runtimePackageVersion: '2.0.1',
    runtimeTag: 'latest',
    publicMcp: 'https://operator.splcart.in/mcp',
    developerMcp: 'https://developer.operator.splcart.in/mcp'
  }),
  policy: Object.freeze({
    runtimeSemverIndependentFromPublicSurface: true,
    productionTruthMustBeExplicitlyPromoted: true
  })
} as const);

export type ReleaseTruth = typeof RELEASE_TRUTH;
