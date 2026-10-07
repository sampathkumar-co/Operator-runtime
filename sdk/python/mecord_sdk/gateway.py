from __future__ import annotations
import hashlib
import hmac
import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, Mapping, Optional

_TRANSPORTS={"mcp","openai","automation","local-sdk","enterprise-sdk"}
_ID=re.compile(r"^[A-Za-z0-9._:@/+\-=]{1,256}$")
_SEMVER=re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")

class MecordSdkError(ValueError):
    pass

def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",",":"), ensure_ascii=False)

def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()

def _iso(value: str) -> str:
    if not isinstance(value,str) or not value.endswith("Z"):
        raise MecordSdkError("timestamp must be canonical UTC ISO")
    try:
        parsed=datetime.fromisoformat(value[:-1]+"+00:00")
    except ValueError as exc:
        raise MecordSdkError("timestamp must be canonical UTC ISO") from exc
    canonical=parsed.isoformat(timespec="milliseconds").replace("+00:00","Z")
    if canonical != value:
        raise MecordSdkError("timestamp must be canonical UTC ISO")
    return value

def build_gateway_proposal(*,transport:str,principal_id:str,adapter_version:str,action:Mapping[str,Any],execution_context:Mapping[str,Any],proposed_at:str)->Dict[str,Any]:
    if transport not in _TRANSPORTS:
        raise MecordSdkError("invalid transport")
    if not _ID.fullmatch(principal_id):
        raise MecordSdkError("invalid principal_id")
    if not _SEMVER.fullmatch(adapter_version):
        raise MecordSdkError("invalid adapter_version")
    if not isinstance(action,Mapping) or not isinstance(execution_context,Mapping):
        raise MecordSdkError("action and execution_context must be objects")
    required={"id","capability","risk","input","provenance"}
    if not required.issubset(action.keys()):
        raise MecordSdkError("action is incomplete")
    if action["risk"] not in {"read","write","external","system","destructive"}:
        raise MecordSdkError("invalid action risk")
    if execution_context.get("schemaVersion") != 1:
        raise MecordSdkError("execution context schemaVersion must be 1")
    if execution_context.get("actionId") not in (None,action["id"]):
        raise MecordSdkError("execution context actionId mismatch")
    proposal={
        "schemaVersion":1,
        "transport":transport,
        "principalId":principal_id,
        "executionContext":dict(execution_context),
        "action":dict(action),
        "adapterVersion":adapter_version,
        "proposedAt":_iso(proposed_at),
    }
    proposal["digest"]=sha256_json(proposal)
    return proposal

def normalize_gateway_receipt(receipt:Mapping[str,Any],proposal_digest:str)->Dict[str,Any]:
    if receipt.get("schemaVersion") != 1:
        raise MecordSdkError("receipt schemaVersion must be 1")
    if receipt.get("proposalDigest") != proposal_digest:
        raise MecordSdkError("receipt proposal digest mismatch")
    status=receipt.get("status")
    if status not in {"ACCEPTED","REJECTED","COMPLETED"}:
        raise MecordSdkError("invalid receipt status")
    _iso(str(receipt.get("receivedAt","")))
    if status=="COMPLETED" and not re.fullmatch(r"[0-9a-f]{64}",str(receipt.get("resultDigest",""))):
        raise MecordSdkError("completed receipt requires resultDigest")
    if status=="REJECTED" and not _ID.fullmatch(str(receipt.get("errorCode",""))):
        raise MecordSdkError("rejected receipt requires errorCode")
    return dict(receipt)

@dataclass(frozen=True)
class TrustedAgentGatewayClient:
    transport:str
    principal_id:str
    adapter_version:str
    now:Callable[[],str]

    def propose(self,action:Mapping[str,Any],execution_context:Optional[Mapping[str,Any]]=None)->Dict[str,Any]:
        context=dict(execution_context or {"schemaVersion":1,"actionId":action["id"]})
        return build_gateway_proposal(transport=self.transport,principal_id=self.principal_id,adapter_version=self.adapter_version,action=action,execution_context=context,proposed_at=self.now())

    def submit(self,action:Mapping[str,Any],adapter:Callable[[Mapping[str,Any]],Mapping[str,Any]],execution_context:Optional[Mapping[str,Any]]=None)->Dict[str,Any]:
        proposal=self.propose(action,execution_context)
        receipt=normalize_gateway_receipt(adapter(proposal),proposal["digest"])
        return {"proposal":proposal,"receipt":receipt}

def verify_webhook_hmac(unsigned:Mapping[str,Any],signature:str,secret:bytes)->bool:
    if len(secret)<32:
        raise MecordSdkError("webhook secret must be at least 32 bytes")
    expected=hmac.new(secret,canonical_json(unsigned).encode("utf-8"),hashlib.sha256).digest()
    import base64
    encoded=base64.urlsafe_b64encode(expected).rstrip(b"=").decode("ascii")
    return hmac.compare_digest(encoded,signature)
