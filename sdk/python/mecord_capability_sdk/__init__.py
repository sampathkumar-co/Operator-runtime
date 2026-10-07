"""Mecord R6 capability-extension SDK (standard-library only)."""
from __future__ import annotations
import hashlib, json, re
from copy import deepcopy

SDK_VERSION=1
REQUIRED_CONFORMANCE_SUITES=("SANDBOX","CONTRACT","ADVERSARIAL","PERFORMANCE")
FIXED_RISKS=("read","write","external","system","destructive")
_ID=re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_CAP=re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_HEX=re.compile(r"^[0-9a-f]{64}$")
_SEMVER=re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")

def canonical_json(value):
    return json.dumps(_canonical(value), separators=(",",":"), ensure_ascii=False)
def _canonical(value):
    if isinstance(value,list): return [_canonical(v) for v in value]
    if isinstance(value,dict): return {k:_canonical(value[k]) for k in sorted(value)}
    return value
def create_extension_manifest(value):
    raw=deepcopy(value); raw["sdkVersion"]=1
    return validate_extension_manifest(raw)
def validate_extension_manifest(raw):
    if not isinstance(raw,dict) or raw.get("sdkVersion")!=1: raise ValueError("sdkVersion must be 1")
    ext_id=str(raw.get("id",""))
    if not _ID.fullmatch(ext_id): raise ValueError("id is invalid")
    version=str(raw.get("version",""))
    if not _SEMVER.fullmatch(version): raise ValueError("version must be SemVer")
    display=_text(raw.get("displayName"),256,"displayName")
    vendor=_text(raw.get("vendor"),256,"vendor") if raw.get("vendor") is not None else None
    provenance=raw.get("provenance")
    if not isinstance(provenance,dict): raise ValueError("provenance is required")
    source=_text(provenance.get("source"),512,"provenance.source")
    package_digest=str(provenance.get("packageDigest","")).lower()
    if not _HEX.fullmatch(package_digest): raise ValueError("provenance.packageDigest must be SHA-256")
    caps=raw.get("capabilities")
    if not isinstance(caps,list) or not 1<=len(caps)<=256: raise ValueError("capabilities must contain 1-256 entries")
    out=[]; seen=set()
    for entry in caps:
        if not isinstance(entry,dict): raise ValueError("capability entry is invalid")
        cap=str(entry.get("capability",""))
        if not _CAP.fullmatch(cap): raise ValueError("capability is invalid")
        if cap in seen: raise ValueError("capability names must be unique")
        seen.add(cap)
        prefix=f"ext.{ext_id}."
        if not cap.startswith(prefix): raise ValueError(f"new capability must be namespaced under {prefix}")
        risk=entry.get("risk")
        if risk not in FIXED_RISKS: raise ValueError("extension capability risk must be fixed")
        reconciliation=entry.get("reconciliation")
        if reconciliation not in ("provider","not-required"): raise ValueError("reconciliation is invalid")
        if risk!="read" and reconciliation!="provider": raise ValueError("mutable capabilities require provider reconciliation")
        verification=entry.get("verification")
        if verification not in ("provider","runtime","external"): raise ValueError("verification is invalid")
        if entry.get("inputSchemaVersion")!=1 or entry.get("cancellation")!="required": raise ValueError("schema/cancellation contract is invalid")
        if not isinstance(entry.get("deterministic"),bool) or not isinstance(entry.get("reversible"),bool): raise ValueError("deterministic/reversible flags are required")
        input_max=_bytes(entry.get("inputMaxBytes"),"inputMaxBytes")
        output_max=_bytes(entry.get("outputMaxBytes"),"outputMaxBytes")
        resources=entry.get("resourceKinds")
        if not isinstance(resources,list) or len(resources)>64 or len(set(resources))!=len(resources): raise ValueError("resourceKinds is invalid")
        out.append({"capability":cap,"risk":risk,"deterministic":entry["deterministic"],"reversible":entry["reversible"],"verification":verification,"reconciliation":reconciliation,"inputSchemaVersion":1,"inputMaxBytes":input_max,"outputMaxBytes":output_max,"cancellation":"required","resourceKinds":sorted(resources)})
    result={"sdkVersion":1,"id":ext_id,"version":version,"displayName":display,"provenance":{"source":source,"packageDigest":package_digest},"capabilities":sorted(out,key=lambda x:x["capability"])}
    if vendor: result["vendor"]=vendor
    return result
def manifest_digest(manifest):
    return hashlib.sha256(canonical_json(validate_extension_manifest(manifest)).encode("utf-8")).hexdigest()
def create_conformance_plan(manifest):
    m=validate_extension_manifest(manifest)
    return {"schemaVersion":1,"manifestDigest":manifest_digest(m),"extensionId":m["id"],"extensionVersion":m["version"],"requiredSuites":list(REQUIRED_CONFORMANCE_SUITES)}
def _text(v,max_len,label):
    if not isinstance(v,str) or not v.strip() or "\x00" in v or len(v.encode("utf-8"))>max_len: raise ValueError(f"{label} is invalid")
    return v.strip()
def _bytes(v,label):
    if not isinstance(v,int) or not 1024<=v<=4194304: raise ValueError(f"{label} must be 1024-4194304")
    return v
