"""Mecord R6 gateway client/capability SDK. Standard-library only."""
from __future__ import annotations
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
import json
import urllib.request
from typing import Any, Dict, Optional


@dataclass(frozen=True)
class CapabilityManifestEntry:
    capability: str
    risk: str
    deterministic: bool
    reversible: bool
    verification: str
    reconciliation: str
    inputSchemaVersion: int
    inputMaxBytes: int
    outputMaxBytes: int
    cancellation: str
    resourceKinds: list[str]


@dataclass(frozen=True)
class GatewayProposal:
    transport: str
    principalId: str
    executionContext: Dict[str, Any]
    action: Dict[str, Any]
    adapterVersion: str
    proposedAt: str
    schemaVersion: int = 1

    @staticmethod
    def create(*, transport: str, principal_id: str, execution_context: Dict[str, Any],
               action: Dict[str, Any], adapter_version: str) -> "GatewayProposal":
        return GatewayProposal(
            transport=transport,
            principalId=principal_id,
            executionContext=execution_context,
            action=action,
            adapterVersion=adapter_version,
            proposedAt=datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        )


class MecordGatewayClient:
    def __init__(self, base_url: str, bearer_token: str):
        if not base_url.startswith(("https://", "http://localhost", "http://127.0.0.1")):
            raise ValueError("Gateway URL must use HTTPS or loopback HTTP")
        if len(bearer_token) < 16:
            raise ValueError("Gateway bearer token is invalid")
        self.base_url = base_url.rstrip("/")
        self.bearer_token = bearer_token

    def execute(self, proposal: GatewayProposal, timeout: float = 30.0) -> Dict[str, Any]:
        payload = json.dumps(asdict(proposal), separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + "/v1/gateway/execute",
            data=payload,
            method="POST",
            headers={
                "content-type": "application/json",
                "authorization": "Bearer " + self.bearer_token,
            },
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            value = json.loads(response.read().decode("utf-8"))
            if not isinstance(value, dict):
                raise ValueError("Gateway returned non-object JSON")
            return value
