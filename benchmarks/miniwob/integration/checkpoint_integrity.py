"""Accidental-tamper-evident ordered checkpoint hash chain.

SHA-256 is NOT a signature or trusted host attestation. Anyone who can
rewrite all rows can recompute this chain. Keep release/receipt signing as a
separate physical acceptance gate.
"""
import hashlib
import json

ZERO_DIGEST="0"*64
class CheckpointIntegrityError(ValueError):
    pass

def seal_row(row,previous=ZERO_DIGEST):
    if type(row) is not dict or type(previous) is not str or len(previous)!=64:
        raise CheckpointIntegrityError("CHECKPOINT_RECORD_INVALID")
    clean={k:v for k,v in row.items() if k not in {"record_sha256","previous_record_sha256"}}
    clean["previous_record_sha256"]=previous
    canonical=json.dumps(clean,sort_keys=True,ensure_ascii=True,
                         separators=(",",":"),allow_nan=False).encode("utf8")
    clean["record_sha256"]=hashlib.sha256(canonical).hexdigest()
    return clean

def verify_file_rows(rows):
    if type(rows) is not list or not rows:
        raise CheckpointIntegrityError("CHECKPOINT_EMPTY")
    previous=ZERO_DIGEST
    for row in rows:
        if type(row) is not dict or row.get("previous_record_sha256")!=previous:
            raise CheckpointIntegrityError("CHECKPOINT_CHAIN_INVALID")
        try:
            check=seal_row(row,previous)
        except (ValueError, TypeError) as exc:
            raise CheckpointIntegrityError("CHECKPOINT_CHAIN_INVALID") from exc
        if row.get("record_sha256")!=check["record_sha256"]:
            raise CheckpointIntegrityError("CHECKPOINT_CHAIN_INVALID")
        previous=row["record_sha256"]
    return previous
