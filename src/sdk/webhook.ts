import {
  createGatewayWebhookSubscription,
  validateGatewayEvent,
  verifyGatewayEventSignature,
  type GatewayEventEnvelope,
  type GatewayEventKind,
  type GatewayWebhookSubscription
} from '../core/gateway-webhook.ts';

export interface GatewayWebhookSubscriptionInput {
  id: string;
  endpoint: string;
  eventKinds: GatewayEventKind[];
  enabled?: boolean;
  createdAt?: string;
}

export function gatewayWebhookSubscription(input: GatewayWebhookSubscriptionInput): GatewayWebhookSubscription {
  return createGatewayWebhookSubscription(input);
}

export class MecordWebhookVerifier {
  #secret: string;

  constructor(secret: string) {
    if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new Error('Webhook verification secret must be at least 32 bytes.');
    }
    this.#secret = secret;
  }

  verify(body: string, signature: string): GatewayEventEnvelope {
    if (!verifyGatewayEventSignature(body, signature, this.#secret)) {
      throw new Error('Webhook signature is invalid.');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); }
    catch { throw new Error('Webhook body is not valid JSON.'); }
    return validateGatewayEvent(parsed as GatewayEventEnvelope);
  }
}
