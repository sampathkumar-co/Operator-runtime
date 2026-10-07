export type R6ContractSchemaName = 'agent-gateway-proposal' | 'capability-extension-manifest' | 'capability-conformance-receipt' | 'signed-agent-webhook';

export const R6_CONTRACT_SCHEMAS = Object.freeze({
  "agent-gateway-proposal": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.mecord.dev/r6/agent-gateway-proposal.schema.json",
    "title": "Mecord Agent Gateway Proposal",
    "type": "object",
    "required": [
      "schemaVersion",
      "transport",
      "principalId",
      "executionContext",
      "action",
      "adapterVersion",
      "proposedAt"
    ],
    "additionalProperties": false,
    "properties": {
      "schemaVersion": {
        "const": 1
      },
      "transport": {
        "enum": [
          "mcp",
          "openai",
          "automation",
          "local-sdk",
          "enterprise-sdk"
        ]
      },
      "principalId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@/+\\\\-=]{1,256}$"
      },
      "executionContext": {
        "type": "object",
        "required": [
          "schemaVersion"
        ],
        "properties": {
          "schemaVersion": {
            "const": 1
          }
        },
        "minProperties": 2
      },
      "action": {
        "type": "object",
        "required": [
          "id",
          "capability",
          "risk",
          "input",
          "provenance"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "capability": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "risk": {
            "enum": [
              "read",
              "write",
              "external",
              "system",
              "destructive"
            ]
          },
          "input": {
            "type": "object"
          },
          "provenance": {
            "type": "object",
            "required": [
              "kind"
            ]
          },
          "taskId": {
            "type": "string"
          },
          "target": {
            "type": "string"
          },
          "intent": {
            "type": "object"
          }
        }
      },
      "adapterVersion": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)\\\\.(0|[1-9][0-9]*)\\\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\\\\+[0-9A-Za-z.-]+)?$"
      },
      "proposedAt": {
        "type": "string",
        "format": "date-time"
      }
    }
  },
  "capability-extension-manifest": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.mecord.dev/r6/capability-extension-manifest.schema.json",
    "title": "Mecord Capability Extension Manifest",
    "type": "object",
    "required": [
      "sdkVersion",
      "id",
      "version",
      "displayName",
      "provenance",
      "capabilities"
    ],
    "additionalProperties": false,
    "properties": {
      "sdkVersion": {
        "const": 1
      },
      "id": {
        "type": "string",
        "pattern": "^[a-z0-9][a-z0-9._-]{0,127}$"
      },
      "version": {
        "type": "string"
      },
      "displayName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "vendor": {
        "type": "string",
        "maxLength": 256
      },
      "provenance": {
        "type": "object",
        "required": [
          "source",
          "packageDigest"
        ],
        "properties": {
          "source": {
            "type": "string"
          },
          "packageDigest": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          }
        }
      },
      "capabilities": {
        "type": "array",
        "minItems": 1,
        "maxItems": 256,
        "items": {
          "type": "object",
          "required": [
            "capability",
            "risk",
            "deterministic",
            "reversible",
            "verification",
            "reconciliation",
            "inputSchemaVersion",
            "inputMaxBytes",
            "outputMaxBytes",
            "cancellation",
            "resourceKinds"
          ],
          "properties": {
            "capability": {
              "type": "string"
            },
            "risk": {
              "enum": [
                "read",
                "write",
                "external",
                "system",
                "destructive",
                "dynamic"
              ]
            },
            "deterministic": {
              "type": "boolean"
            },
            "reversible": {
              "type": "boolean"
            },
            "verification": {
              "enum": [
                "provider",
                "runtime",
                "external"
              ]
            },
            "reconciliation": {
              "enum": [
                "provider",
                "not-required"
              ]
            },
            "inputSchemaVersion": {
              "const": 1
            },
            "inputMaxBytes": {
              "type": "integer",
              "minimum": 1024,
              "maximum": 4194304
            },
            "outputMaxBytes": {
              "type": "integer",
              "minimum": 1024,
              "maximum": 4194304
            },
            "cancellation": {
              "const": "required"
            },
            "resourceKinds": {
              "type": "array",
              "maxItems": 64,
              "items": {
                "type": "string"
              }
            }
          }
        }
      }
    }
  },
  "capability-conformance-receipt": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.mecord.dev/r6/capability-conformance-receipt.schema.json",
    "title": "Mecord Capability Conformance Receipt",
    "type": "object",
    "required": [
      "schemaVersion",
      "id",
      "suite",
      "manifestDigest",
      "verifierId",
      "independent",
      "passed",
      "evidenceArtifactIds",
      "observedAt"
    ],
    "additionalProperties": false,
    "properties": {
      "schemaVersion": {
        "const": 1
      },
      "id": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      },
      "suite": {
        "enum": [
          "SANDBOX",
          "CONTRACT",
          "ADVERSARIAL",
          "PERFORMANCE"
        ]
      },
      "manifestDigest": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      },
      "verifierId": {
        "type": "string"
      },
      "independent": {
        "type": "boolean"
      },
      "passed": {
        "type": "boolean"
      },
      "evidenceArtifactIds": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "observedAt": {
        "type": "string",
        "format": "date-time"
      },
      "metrics": {
        "type": "object"
      }
    }
  },
  "signed-agent-webhook": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.mecord.dev/r6/signed-agent-webhook.schema.json",
    "title": "Mecord Signed Agent Webhook",
    "type": "object",
    "required": [
      "schemaVersion",
      "deliveryId",
      "subscriptionId",
      "eventType",
      "occurredAt",
      "payload",
      "payloadDigest",
      "signature"
    ],
    "additionalProperties": false,
    "properties": {
      "schemaVersion": {
        "const": 1
      },
      "deliveryId": {
        "type": "string"
      },
      "subscriptionId": {
        "type": "string"
      },
      "eventType": {
        "type": "string"
      },
      "occurredAt": {
        "type": "string",
        "format": "date-time"
      },
      "payload": {
        "type": "object"
      },
      "payloadDigest": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      },
      "signature": {
        "type": "string"
      }
    }
  }
} as const);

export function r6ContractSchema(name:R6ContractSchemaName):Record<string,unknown>{
  const schema=R6_CONTRACT_SCHEMAS[name];
  return structuredClone(schema) as unknown as Record<string,unknown>;
}
