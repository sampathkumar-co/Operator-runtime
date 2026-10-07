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
    runtimePackageVersion: '2.0.5',
    bootstrapPackageVersion: '1.0.0'
  }),
  production: Object.freeze({
    statusDate: '2026-10-07',
    sourceCommit: 'ef3bcdc2fcbc56b1b42f7a7a6f09ceabfc5a2bf2',
    publicSurfaceVersion: '1.0.0',
    runtimePackageVersion: '2.0.5',
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
