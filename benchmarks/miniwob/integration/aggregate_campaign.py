"""Fail-closed report-only MiniWoB worker aggregation. Never dispatches browser/model actions."""
import argparse
import json
from hashlib import sha256
from pathlib import Path

class CampaignError(ValueError):
    pass

def aggregate(paths, expected, seed, workers):
    if type(expected) is not int or not 1 <= expected <= 125:
        raise CampaignError("EXPECTED_ROSTER_INVALID")
    if type(workers) is not int or not 1 <= workers <= 4:
        raise CampaignError("WORKER_COUNT_INVALID")
    if not paths or len(paths) != workers:
        raise CampaignError("WORKER_FILE_COUNT_MISMATCH")
    seen, manifest, source_files, per_worker = {}, None, set(), set()
    for source in paths:
        source = Path(source).resolve(strict=True)
        if source in source_files:
            raise CampaignError("DUPLICATE_FILE")
        source_files.add(source)
        rows = [json.loads(line) for line in source.read_text(encoding="utf8").splitlines() if line.strip()]
        if not rows:
            raise CampaignError("EMPTY_WORKER_RESULT")
        worker = rows[0].get("worker")
        # Older checkpoint files lack worker fields on each episode: do not
        # silently infer their membership from filenames.
        if type(worker) is not int or not 0 <= worker < workers or worker in per_worker:
            raise CampaignError("WORKER_PROVENANCE_INVALID")
        per_worker.add(worker)
        indexes=[]
        for row in rows:
            if type(row) is not dict or row.get("worker") != worker or row.get("workers") != workers:
                raise CampaignError("WORKER_ROW_INVALID")
            if row.get("seed") != seed or type(row.get("plan_index")) is not int:
                raise CampaignError("SEED_OR_INDEX_INVALID")
            index=row["plan_index"]
            if index not in range(expected) or index % workers != worker or index in seen:
                raise CampaignError("DUPLICATE_OR_MISROUTED_TASK")
            task=row.get("task_id")
            if type(task) is not str or not task.startswith("browsergym/miniwob."):
                raise CampaignError("TASK_ID_INVALID")
            digest=row.get("global_campaign_sha256")
            if type(digest) is not str or len(digest) != 64 or (manifest is not None and manifest != digest):
                raise CampaignError("CAMPAIGN_MANIFEST_MISMATCH")
            manifest = digest
            score=row.get("reward")
            if row.get("unscored") is True:
                if score is not None:
                    raise CampaignError("UNSCORED_REWARD_MUST_BE_NULL")
            elif type(score) not in (int,float) or score not in (0,1):
                raise CampaignError("REWARD_INVALID")
            seen[index]=row
            indexes.append(index)
        if indexes != sorted(indexes):
            raise CampaignError("WORKER_ORDER_INVALID")
    if len(seen) != expected:
        raise CampaignError("CAMPAIGN_INCOMPLETE")
    reconstructed=sha256(json.dumps([(i,seen[i]["task_id"]) for i in range(expected)],
        separators=(",",":"),ensure_ascii=True).encode()).hexdigest()
    if reconstructed != manifest:
        raise CampaignError("MANIFEST_HASH_INVALID")
    unscored=sum(row.get("unscored") is True for row in seen.values())
    successes=sum(row.get("reward")==1 and row.get("unscored") is not True for row in seen.values())
    scored=expected-unscored
    return {"expected":expected,"seed":seed,"workers":workers,
            "manifest_sha256":manifest,"attempted":expected,"scored":scored,
            "successes":successes,"failures":scored-successes,"unscored":unscored,
            "score":successes/expected,
            "gate_70_percent":"PASS" if unscored==0 and expected==50 and successes>=35
                else "FAIL" if unscored==0 and expected==50 else "NOT_EVALUATED",
            "qualification":"COMPLETE" if unscored==0 else "UNSCORED_EPISODES_PRESENT"}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("paths",nargs="+",type=Path)
    parser.add_argument("--expected",type=int,required=True)
    parser.add_argument("--seed",type=int,default=42)
    parser.add_argument("--workers",type=int,required=True)
    args=parser.parse_args()
    print(json.dumps(aggregate(args.paths,args.expected,args.seed,args.workers),sort_keys=True))

if __name__=="__main__":main()
