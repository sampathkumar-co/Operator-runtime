"""Offline, source-aware aggregation for frozen MiniWoB checkpoints.

No browser actions, model calls, credentials or network access.
"""
from __future__ import annotations
import argparse
import json
import subprocess
from hashlib import sha256
from pathlib import Path

SOURCE_SHA="7fd85d71a4b60325c6585396ec4f48377d049838"
MODEL="meta-muse-spark-1.3-contributor"
EXECUTOR="mecord-browser.cdp-isolated"
class CampaignError(ValueError):
    pass

def frozen_plan(roster,expected):
    if type(expected) is not int or not 1<=expected<=125:
        raise CampaignError("EXPECTED_ROSTER_INVALID")
    if type(roster) is not list or len(roster)!=125 or len(set(roster))!=125 or any(
            type(v) is not str or not v.startswith("browsergym/miniwob.") for v in roster):
        raise CampaignError("CANONICAL_125_TASK_ROSTER_REQUIRED")
    indices=list(range(125)) if expected==125 else (
        [round(i*124/(expected-1)) for i in range(expected)] if expected>1 else [0])
    return [(i,roster[k]) for i,k in enumerate(indices)]

def digest_plan(plan):
    return sha256(json.dumps(plan,separators=(",",":"),ensure_ascii=True).encode()).hexdigest()

def aggregate(paths, expected, seed, workers, *, roster, harness_sha256):
    if type(workers) is not int or not 1<=workers<=4:
        raise CampaignError("WORKER_COUNT_INVALID")
    if type(seed) is not int or not 0<=seed<=2**32-1:
        raise CampaignError("SEED_INVALID")
    if type(harness_sha256) is not str or len(harness_sha256)!=64 or any(
            c not in "0123456789abcdef" for c in harness_sha256):
        raise CampaignError("HARNESS_DIGEST_REQUIRED")
    plan=frozen_plan(roster,expected)
    manifest=digest_plan(plan)
    if not paths:raise CampaignError("NO_CHECKPOINT_FILES")
    seen={}
    seen_files=set()
    visions=set()
    step_limits=set()
    observed_workers=set()
    for supplied in paths:
        source=Path(supplied).resolve(strict=True)
        if source in seen_files:raise CampaignError("DUPLICATE_FILE")
        seen_files.add(source)
        rows=[json.loads(x) for x in source.read_text(encoding="utf8").splitlines() if x.strip()]
        if not rows:raise CampaignError("EMPTY_CHECKPOINT")
        worker=rows[0].get("worker")
        if type(worker) is not int or not 0<=worker<workers:
            raise CampaignError("WORKER_PROVENANCE_INVALID")
        observed_workers.add(worker)
        local_indexes=[]
        for row in rows:
            if type(row) is not dict or row.get("worker")!=worker or row.get("workers")!=workers:
                raise CampaignError("WORKER_ROW_INVALID")
            index=row.get("plan_index")
            if type(index) is not int or not 0<=index<expected or index%workers!=worker:
                raise CampaignError("MISROUTED_TASK")
            if index in seen:raise CampaignError("OVERLAPPING_CHECKPOINTS")
            if row.get("task_id")!=plan[index][1]:
                raise CampaignError("TASK_NOT_IN_CANONICAL_FROZEN_PLAN")
            if row.get("seed")!=seed or row.get("global_campaign_sha256")!=manifest:
                raise CampaignError("SEED_OR_MANIFEST_MISMATCH")
            if row.get("harness_sha256")!=harness_sha256 or row.get("source_commit")!=SOURCE_SHA:
                raise CampaignError("HARNESS_OR_SOURCE_REVISION_MISMATCH")
            if row.get("agent")!=MODEL or row.get("executor")!=EXECUTOR:
                raise CampaignError("MODEL_OR_EXECUTOR_MISMATCH")
            if type(row.get("vision_enabled")) is not bool:
                raise CampaignError("VISION_PROVENANCE_MISSING")
            visions.add(row["vision_enabled"])
            if type(row.get("step_limit")) is not int or not 1<=row["step_limit"]<=10:
                raise CampaignError("STEP_LIMIT_INVALID")
            step_limits.add(row["step_limit"])
            val=row.get("reward")
            if row.get("unscored") is True:
                if val is not None:raise CampaignError("UNSCORED_MUST_HAVE_NULL_REWARD")
            elif type(val) not in (int,float) or val not in (0,1):
                raise CampaignError("SCORED_REWARD_INVALID")
            if type(row.get("steps")) is not int or not 0<=row["steps"]<=row["step_limit"]:
                raise CampaignError("STEPS_INVALID")
            seen[index]=row
            local_indexes.append(index)
        if local_indexes!=sorted(local_indexes):
            raise CampaignError("CHECKPOINT_ORDER_INVALID")
    if len(visions)!=1 or len(step_limits)!=1:
        raise CampaignError("MIXED_TEST_CONDITIONS")
    present=len(seen)
    unscored=sum(r.get("unscored") is True for r in seen.values())
    successful=sum(r.get("unscored") is not True and r.get("reward")==1 for r in seen.values())
    scored=present-unscored
    complete=(present==expected and unscored==0 and observed_workers==set(range(workers)))
    missing=[i for i in range(expected) if i not in seen]
    return {"expected":expected,"seed":seed,"workers":workers,
            "frozen_manifest_sha256":manifest,"harness_sha256":harness_sha256,
            "vision_enabled":next(iter(visions)),"step_limit":next(iter(step_limits)),
            "attempted":present,"scored":scored,"successes":successful,
            "failures":scored-successful,"unscored":unscored,"missing":len(missing),
            "first_missing_indexes":missing[:25],
            "observed_success_rate":successful/scored if scored else None,
            "conservative_lower_bound":successful/expected,
            "full_score":successful/expected if complete else None,
            "gate_70_percent":("PASS" if successful>=35 else "FAIL")
                    if complete and expected==50 else "NOT_EVALUATED",
            "status":"COMPLETE" if complete else "PARTIAL"}

def main():
    p=argparse.ArgumentParser()
    p.add_argument("paths",nargs="+",type=Path)
    p.add_argument("--expected",type=int,default=50)
    p.add_argument("--seed",type=int,default=42)
    p.add_argument("--workers",type=int,default=1)
    p.add_argument("--harness-sha256",required=True)
    args=p.parse_args()
    import gymnasium as gym
    import browsergym.miniwob
    root=Path(__file__).resolve().parents[1]
    result=subprocess.run(["git","-C",str(root/"miniwob-plusplus"),"rev-parse","HEAD"],
        check=True,capture_output=True,text=True)
    if result.stdout.strip()!=SOURCE_SHA:
        raise CampaignError("MINIWOB_SOURCE_REVISION_MISMATCH")
    roster=sorted(str(x) for x in gym.envs.registry if str(x).startswith("browsergym/miniwob."))
    print(json.dumps(aggregate(args.paths,args.expected,args.seed,args.workers,
        roster=roster,harness_sha256=args.harness_sha256),sort_keys=True))

if __name__=="__main__":main()
