export type ActionRisk='read'|'write'|'external'|'system'|'destructive';
export type VerificationMode='provider'|'runtime'|'external';
export type ReconciliationMode='provider'|'not-required';
export interface CapabilityManifestEntry{capability:string;risk:ActionRisk;deterministic:boolean;reversible:boolean;verification:VerificationMode;reconciliation:ReconciliationMode;inputSchemaVersion:1;inputMaxBytes:number;outputMaxBytes:number;cancellation:'required';resourceKinds:string[]}
export interface CapabilityExtensionManifest{sdkVersion:1;id:string;version:string;displayName:string;vendor?:string;provenance:{source:string;packageDigest:string};capabilities:CapabilityManifestEntry[]}
export declare const SDK_VERSION:1;
export declare const REQUIRED_CONFORMANCE_SUITES:readonly ['SANDBOX','CONTRACT','ADVERSARIAL','PERFORMANCE'];
export declare const FIXED_RISKS:readonly ActionRisk[];
export declare function canonicalJson(value:unknown):string;
export declare function manifestDigest(manifest:CapabilityExtensionManifest):string;
export declare function createExtensionManifest(input:Omit<CapabilityExtensionManifest,'sdkVersion'> & {sdkVersion?:1}):CapabilityExtensionManifest;
export declare function validateExtensionManifest(input:unknown):CapabilityExtensionManifest;
export declare function createConformancePlan(manifest:CapabilityExtensionManifest):{schemaVersion:1;manifestDigest:string;extensionId:string;extensionVersion:string;requiredSuites:string[]};
export declare function createGatewayProposal(input:{transport:'mcp'|'openai'|'automation'|'local-sdk'|'enterprise-sdk';principalId:string;executionContext:Record<string,unknown>;action:Record<string,unknown>;adapterVersion:string;proposedAt:string}):Record<string,unknown>&{digest:string};
