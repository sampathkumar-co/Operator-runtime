"""Mecord R6 gateway client/capability SDK. Standard-library only."""
from __future__ import annotations
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
import json
import urllib.request
import urllib.parse
import hashlib
import hmac
import re
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
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme not in {"https", "http"} or not parsed.hostname:
            raise ValueError("Gateway URL must use HTTPS or loopback HTTP")
        if parsed.username is not None or parsed.password is not None or parsed.fragment:
            raise ValueError("Gateway URL must not embed credentials or fragments")
        if parsed.scheme == "http" and parsed.hostname.lower() not in {"localhost", "127.0.0.1", "::1"}:
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


@dataclass(frozen=True)
class CapabilityManifest:
    id: str
    version: str
    displayName: str
    provenance: Dict[str, str]
    capabilities: list[CapabilityManifestEntry]
    vendor: Optional[str] = None
    sdkVersion: int = 1

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def validate(self) -> Dict[str, Any]:
        return validate_manifest(self.to_dict())


def validate_manifest(value: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(value, dict) or value.get("sdkVersion") != 1:
        raise ValueError("Capability manifest sdkVersion must be 1")
    identifier = value.get("id")
    if not isinstance(identifier, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", identifier):
        raise ValueError("Capability manifest id is invalid")
    version = value.get("version")
    if not isinstance(version, str) or not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
        raise ValueError("Capability manifest version must be SemVer")
    provenance = value.get("provenance")
    if not isinstance(provenance, dict) or not re.fullmatch(r"[0-9a-f]{64}", str(provenance.get("packageDigest", ""))):
        raise ValueError("Capability manifest packageDigest must be lowercase SHA-256")
    entries = value.get("capabilities")
    if not isinstance(entries, list) or not 1 <= len(entries) <= 256:
        raise ValueError("Capability manifest must declare 1-256 capabilities")
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Capability manifest entry is invalid")
        name = entry.get("capability")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", name):
            raise ValueError("Capability name is invalid")
        if name in seen:
            raise ValueError("Capability manifest contains duplicate capabilities")
        seen.add(name)
        if entry.get("risk") not in {"read", "write", "external", "system", "destructive", "dynamic"}:
            raise ValueError("Capability risk is invalid")
        if entry.get("verification") not in {"provider", "runtime", "external"}:
            raise ValueError("Capability verification mode is invalid")
        if entry.get("reconciliation") not in {"provider", "not-required"}:
            raise ValueError("Capability reconciliation mode is invalid")
        if entry.get("inputSchemaVersion") != 1 or entry.get("cancellation") != "required":
            raise ValueError("Capability schema/cancellation contract is invalid")
        for key in ("inputMaxBytes", "outputMaxBytes"):
            bound = entry.get(key)
            if not isinstance(bound, int) or not 1024 <= bound <= 4 * 1024 * 1024:
                raise ValueError(f"{key} is out of bounds")
    return json.loads(json.dumps(value))


def sign_webhook_body(body: str, secret: str) -> str:
    if len(secret.encode("utf-8")) < 32:
        raise ValueError("Webhook secret must be at least 32 bytes")
    return hmac.new(secret.encode("utf-8"), body.encode("utf-8"), hashlib.sha256).hexdigest()


def verify_webhook_signature(body: str, signature: str, secret: str) -> bool:
    if not re.fullmatch(r"[0-9a-f]{64}", signature or ""):
        return False
    try:
        expected = sign_webhook_body(body, secret)
    except ValueError:
        return False
    return hmac.compare_digest(expected, signature)
