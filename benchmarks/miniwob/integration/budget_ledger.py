"""Small synchronous, cross-process budget reservation ledger for a synthetic benchmark.
No model/network imports; never steals a lock, retries boundedly and fails closed.
"""
from __future__ import annotations
import json
import math
import os
import secrets
import time
from pathlib import Path

class BudgetError(RuntimeError):
    pass

class BudgetLedger:
 def __init__(self,directory,*,lifetime_cap,run_cap,worker,workers,manifest):
    self.root=Path(directory).resolve(strict=True)
    self.lock=self.root/".mecord-budget.lock"
    self.ledger=self.root/"mecord-api-reservations.jsonl"
    if not (math.isfinite(lifetime_cap) and 0<lifetime_cap<=1 and
            math.isfinite(run_cap) and 0<run_cap<=lifetime_cap and
            type(worker) is int and type(workers) is int and 0<=worker<workers<=4 and
            isinstance(manifest,str) and len(manifest)==64):
        raise BudgetError("BUDGET_CONFIGURATION_INVALID")
    self.lifetime_cap,self.run_cap=lifetime_cap,run_cap
    self.worker,self.workers,self.manifest=worker,workers,manifest
    self.run_reserved=0.0
    self.workspace_reserved=0.0

 def _sum(self):
    total=0.0
    if self.ledger.exists():
        for line in self.ledger.read_text(encoding="utf8").splitlines():
            try: receipt=json.loads(line)
            except ValueError: raise BudgetError("MODEL_LEDGER_CORRUPT") from None
            amount=receipt.get("usd") if type(receipt) is dict else None
            if type(amount) not in (int,float) or not math.isfinite(amount) or amount<=0:
                raise BudgetError("MODEL_LEDGER_CORRUPT")
            total+=amount
    return total

 def reserve(self,amount):
    if type(amount) not in (float,int) or not math.isfinite(amount) or amount<=0:
        raise BudgetError("INVALID_API_RESERVATION")
    marker=f"{os.getpid()}-{secrets.token_hex(16)}"
    deadline=time.monotonic()+12
    while True:
        try:
            fd=os.open(self.lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
            try:
                os.write(fd,marker.encode("ascii"))
                os.fsync(fd)
            finally:os.close(fd)
            break
        except FileExistsError:
            if time.monotonic()>deadline:
                raise BudgetError("BENCHMARK_BUDGET_LOCK_BUSY")
            time.sleep(0.025)
    try:
        current=self._sum()
        if self.run_reserved+amount>self.run_cap+1e-12 or current+amount>self.lifetime_cap+1e-12:
            raise BudgetError("BUDGET_CAP_REACHED")
        row={"usd":round(amount,9),"type":"api_reservation",
             "worker":self.worker,"workers":self.workers,
             "global_manifest":self.manifest}
        with self.ledger.open("a",encoding="utf8") as f:
            f.write(json.dumps(row,separators=(",",":"))+"\n")
            f.flush()
            os.fsync(f.fileno())
        self.workspace_reserved=current+amount
        self.run_reserved+=amount
        return self.workspace_reserved,self.run_reserved
    finally:
        try:
            if self.lock.read_text(encoding="ascii")==marker:
                self.lock.unlink()
        except OSError:pass


def require_budget_feasibility(*, task_count, vision, run_cap, lifetime_cap,
                               already_reserved, output_tokens=2048):
    """Fail BEFORE Meta/browser startup if a planned vision batch cannot fit.

    A lower bound on the harness's conservative reservation, not a provider
    quote or permission to charge more. Atomic reserve() is still authoritative.
    """
    if (type(task_count) is not int or task_count < 1 or
        type(vision) is not bool or
        any(type(x) not in (int, float) or not math.isfinite(x)
            for x in (run_cap, lifetime_cap, already_reserved)) or
        not 0 < run_cap <= lifetime_cap or
        not 0 <= already_reserved <= lifetime_cap or
        type(output_tokens) is not int or not 256 <= output_tokens <= 3072):
        raise BudgetError("BUDGET_PREFLIGHT_INVALID")
    if not vision:
        return
    # Each task needs at least one screenshot-bearing Meta request.
    # The live runner reserves 32,768 image input tokens and output_tokens.
    min_per_task = (32768 * 0.10 + output_tokens * 0.20) / 1e6
    required = task_count * min_per_task
    if required > run_cap + 1e-12 or required > lifetime_cap - already_reserved + 1e-12:
        raise BudgetError("VISION_RESERVATION_INFEASIBLE_USE_SMALLER_CHECKPOINT")
