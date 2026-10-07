export const R6_AGENT_GATEWAY_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mecord.tech/contracts/r6/agent-gateway-proposal-v1.schema.json",
  "title": "Mecord Agent Gateway Proposal v1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "transport",
    "principalId",
    "executionContext",
    "action",
    "adapterVersion",
    "proposedAt"
  ],
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
          "type": "string"
        },
        "capability": {
          "type": "string"
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
          "type": "object"
        }
      }
    },
    "adapterVersion": {
      "type": "string",
      "pattern": "^(0|[1-9][0-9]*)\\\\.(0|[1-9][0-9]*)\\\\.(0|[1-9][0-9]*)"
    },
    "proposedAt": {
      "type": "string",
      "format": "date-time"
    }
  }
} as const;
export const R6_CAPABILITY_MANIFEST_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mecord.tech/contracts/r6/capability-manifest-v1.schema.json",
  "title": "Mecord Capability Extension Manifest v1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "sdkVersion",
    "id",
    "version",
    "displayName",
    "provenance",
    "capabilities"
  ],
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
            "items": {
              "type": "string"
            },
            "maxItems": 64
          }
        }
      }
    }
  }
} as const;
export const R6_GATEWAY_EVENT_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mecord.tech/contracts/r6/gateway-event-v1.schema.json",
  "title": "Mecord Gateway Event v1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "id",
    "kind",
    "occurredAt",
    "subjectId",
    "data"
  ],
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "id": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    },
    "kind": {
      "enum": [
        "operation.started",
        "operation.completed",
        "operation.failed",
        "capability.certified",
        "capability.revoked",
        "device.changed"
      ]
    },
    "occurredAt": {
      "type": "string",
      "format": "date-time"
    },
    "subjectId": {
      "type": "string"
    },
    "data": {
      "type": "object"
    }
  }
} as const;
export const R6_OPENAPI = {
  "openapi": "3.1.0",
  "info": {
    "title": "Mecord Universal Agent Gateway",
    "version": "1.0.0"
  },
  "paths": {
    "/v1/gateway/execute": {
      "post": {
        "operationId": "executeGatewayProposal",
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/AgentGatewayProposal"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Verified execution receipt"
          },
          "400": {
            "description": "Invalid proposal"
          },
          "403": {
            "description": "Principal/authority mismatch"
          },
          "409": {
            "description": "Execution completed with a bounded failure"
          },
          "423": {
            "description": "Emergency stop engaged"
          }
        }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "bearerAuth": {
        "type": "http",
        "scheme": "bearer"
      }
    },
    "schemas": {
      "AgentGatewayProposal": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://mecord.tech/contracts/r6/agent-gateway-proposal-v1.schema.json",
        "title": "Mecord Agent Gateway Proposal v1",
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schemaVersion",
          "transport",
          "principalId",
          "executionContext",
          "action",
          "adapterVersion",
          "proposedAt"
        ],
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
                "type": "string"
              },
              "capability": {
                "type": "string"
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
                "type": "object"
              }
            }
          },
          "adapterVersion": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)\\\\.(0|[1-9][0-9]*)\\\\.(0|[1-9][0-9]*)"
          },
          "proposedAt": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CapabilityManifest": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://mecord.tech/contracts/r6/capability-manifest-v1.schema.json",
        "title": "Mecord Capability Extension Manifest v1",
        "type": "object",
        "additionalProperties": false,
        "required": [
          "sdkVersion",
          "id",
          "version",
          "displayName",
          "provenance",
          "capabilities"
        ],
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
                  "items": {
                    "type": "string"
                  },
                  "maxItems": 64
                }
              }
            }
          }
        }
      },
      "GatewayEvent": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://mecord.tech/contracts/r6/gateway-event-v1.schema.json",
        "title": "Mecord Gateway Event v1",
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schemaVersion",
          "id",
          "kind",
          "occurredAt",
          "subjectId",
          "data"
        ],
        "properties": {
          "schemaVersion": {
            "const": 1
          },
          "id": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          },
          "kind": {
            "enum": [
              "operation.started",
              "operation.completed",
              "operation.failed",
              "capability.certified",
              "capability.revoked",
              "device.changed"
            ]
          },
          "occurredAt": {
            "type": "string",
            "format": "date-time"
          },
          "subjectId": {
            "type": "string"
          },
          "data": {
            "type": "object"
          }
        }
      }
    }
  }
} as const;
