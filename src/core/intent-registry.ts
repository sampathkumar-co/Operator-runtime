import path from 'node:path';
import { OperatorError } from './errors.ts';
import { IntentKernel, type IntentDirective, type IntentEnvelope } from './intent-kernel.ts';
import type { IntentBinding } from './types.ts';

export class IntentRegistry {
  #stateDir: string;

  constructor(stateDir: string) {
    this.#stateDir = path.resolve(stateDir);
  }

  kernel(conversationId: string): IntentKernel {
    return new IntentKernel(this.#stateDir, conversationId);
  }

  async current(conversationId: string): Promise<IntentEnvelope | undefined> {
    return await this.kernel(conversationId).current();
  }

  async update(conversationId: string, input: {
    objective: string;
    authorizedScope?: string[];
    prohibitedScope?: string[];
    directive: IntentDirective;
    sourceTurnId: string;
  }): Promise<IntentEnvelope> {
    return await this.kernel(conversationId).update(input);
  }

  async assertCurrent(binding: IntentBinding): Promise<IntentEnvelope> {
    const normalized = validIntentBinding(binding);
    return await this.kernel(normalized.conversationId).assertCurrent(normalized.intentVersion, normalized.digest);
  }

  async assertExecutable(binding: IntentBinding): Promise<IntentEnvelope> {
    const intent = await this.assertCurrent(binding);
    if (intent.directive === 'pause' || intent.directive === 'cancel' || intent.directive === 'revoke') {
      throw new OperatorError('INTENT_NOT_EXECUTABLE', `Intent directive ${intent.directive} does not authorize forward execution.`, {
        retryable: false,
        details: { directive: intent.directive, intentVersion: intent.intentVersion }
      });
    }
    return intent;
  }
}

export function bindingForIntent(intent: IntentEnvelope): IntentBinding {
  return {
    conversationId: intent.conversationId,
    intentVersion: intent.intentVersion,
    digest: intent.digest
  };
}

export function validIntentBinding(input: unknown): IntentBinding {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('INTENT_BINDING_INVALID', 'Intent binding must be an object.');
  }
  const raw = input as Record<string, unknown>;
  const conversationId = String(raw.conversationId ?? '');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(conversationId)) {
    throw new OperatorError('INTENT_BINDING_INVALID', 'Intent conversationId is invalid.');
  }
  // Intent versions identify an exact authorization revision; rejecting
  // nonnumeric JSON types prevents implicit conversion of stale/foreign input.
  const intentVersion = raw.intentVersion;
  if (typeof intentVersion !== 'number' || !Number.isSafeInteger(intentVersion) || intentVersion < 1) {
    throw new OperatorError('INTENT_BINDING_INVALID', 'Intent version is invalid.');
  }
  const digest = String(raw.digest ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new OperatorError('INTENT_BINDING_INVALID', 'Intent digest is invalid.');
  }
  return { conversationId, intentVersion, digest };
}
