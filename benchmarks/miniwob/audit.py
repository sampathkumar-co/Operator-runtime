"""Audit reproducible MiniWoB JSONL without allowing selection of good tasks."""
import argparse, json, hashlib, statistics
from pathlib import Path
def audit(result_dir:Path,prefix:str,limit:int,seed:int,workers:int)->dict:
    allrows=[];meta=[];hashes={}
    for index in range(workers):
        filename=f"{prefix}_{limit}_seed{seed}_w{index}of{workers}.jsonl"
        path=result_dir/filename
        raw=path.read_bytes()
        hashes[filename]=hashlib.sha256(raw).hexdigest()
        rows=[json.loads(line) for line in raw.decode("utf8").splitlines() if line.strip()]
        if any(row.get("idx")%workers!=index for row in rows):
            raise AssertionError("WORKER_PARTITION_MISMATCH")
        meta.append({"worker":index,"episodes":len(rows),"successes":sum(row.get("reward")==1 for row in rows),
                     "max_cumulative_cost_usd":rows[-1]["cumulative_cost_usd"] if rows else 0})
        allrows.extend(rows)
    if len(allrows)!=limit:raise AssertionError(f"EXPECTED_{limit}_GOT_{len(allrows)}")
    if sorted(x["idx"] for x in allrows)!=list(range(limit)):raise AssertionError("MISSING_OR_DUPLICATE_INDICES")
    if len(set(x["task_id"] for x in allrows))!=limit:raise AssertionError("DUPLICATE_TASK_IDS")
    if any(x["seed"]!=seed for x in allrows):raise AssertionError("SEED_MISMATCH")
    passed=sum(x["reward"]==1 for x in allrows)
    kinds={}
    for row in allrows:
        name=(row.get("error") or "UNSOLVED" if row["reward"]!=1 else "SUCCESS")
        if row["reward"]==1:name="SUCCESS"
        kinds[name]=kinds.get(name,0)+1
    return {"scope":"Model + reconstructed controller + Mecord native browser provider, synthetic isolated Chrome (not production relay)",
            "tasks":limit,"seed":seed,"workers":workers,"success":passed,
            "success_rate":round(passed/limit,4),
            "model_calls":sum(x["model_calls"] for x in allrows),
            "provider_operations":sum(x["mecord_operations"] for x in allrows),
            "estimated_meta_usd":round(sum(w["max_cumulative_cost_usd"] for w in meta),8),
            "duration_median_s":round(statistics.median(x["elapsed_s"] for x in allrows),2),
            "failure_breakdown":dict(sorted(kinds.items(),key=lambda v:-v[1])),
            "worker_details":meta,"sha256_jsonl":hashes}
if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--results",type=Path,default=Path(__file__).resolve().parent/"results")
    p.add_argument("--prefix",default="restored_meta_v2")
    p.add_argument("--limit",type=int,required=True)
    p.add_argument("--seed",type=int,default=42)
    p.add_argument("--workers",type=int,default=4)
    args=p.parse_args()
    data=audit(args.results,args.prefix,args.limit,args.seed,args.workers)
    target=args.results/f"{args.prefix}_{args.limit}_seed{args.seed}_verified.json"
    with target.open("x",encoding="utf8") as f:json.dump(data,f,indent=2)
    print("VERIFIED_BENCHMARK="+json.dumps(data),flush=True)
