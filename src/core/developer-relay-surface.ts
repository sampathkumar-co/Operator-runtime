import { CAPABILITY_RISK_RULES } from './capability-policy.ts';

export const DEVELOPER_RELAY_CAPABILITIES = Object.freeze(
  Object.keys(CAPABILITY_RISK_RULES).sort()
);
