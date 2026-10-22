"""Verify completeness, immutable logs and independent MiniWoB rewards for native provider runs."""
from pathlib import Path
import argparse,json,hashlib,statistics
p=argparse.ArgumentParser()
p.add_argument("--limit",type=int,required=True);p.add_argument("--seed",type=int,required=True)
p.add_argument("--workers",type=int,required=True);p.add_argument("--results",type=Path,default=Path(__file__).parent/"results")
args=p.parse_args()
assert 1<=args.limit<=125 and 1<=args.workers<=4
allrows=[];workers=[];hashes={}
for index in range(args.workers):
 f=args.results/f"native_{args.limit}_seed{args.seed}_w{index}of{args.workers}.jsonl"
 raw=f.read_bytes()
 rows=[json.loads(row) for row in raw.decode("utf8").splitlines() if row.strip()]
 if any(r["idx"]%args.workers!=index for r in rows):raise AssertionError("WORKER_PARTITION_MISMATCH")
 if any(r["seed"]!=args.seed for r in rows):raise AssertionError("SEED_MISMATCH")
 allrows.extend(rows)
 workers.append({"worker":index,"tasks":len(rows),"success":sum(r["reward"]==1 for r in rows),
                 "cost_usd":rows[-1]["cost_cumulative"] if rows else 0})
 hashes[f.name]=hashlib.sha256(raw).hexdigest()
if len(allrows)!=args.limit:raise AssertionError(f"EXPECTED_{args.limit}_GOT_{len(allrows)}")
if sorted(x["idx"] for x in allrows)!=list(range(args.limit)):raise AssertionError("MISSING_OR_DUPLICATE_INDICES")
if len({x["task_id"] for x in allrows})!=args.limit:raise AssertionError("DUPLICATE_TASK_NAMES")
success=sum(row.get("reward")==1 for row in allrows)
errors={}
for row in allrows:
 k="SUCCESS" if row["reward"]==1 else str(row.get("error") or "UNSOLVED")
 errors[k]=errors.get(k,0)+1
result={"tasks":args.limit,"seed":args.seed,"success":success,"rate":round(success/args.limit,4),
        "calls":sum(x["model_calls"] for x in allrows),
        "mecord_native_operations":sum(x["mecord_calls"] for x in allrows),
        "estimated_api_cost_usd":round(sum(w["cost_usd"] for w in workers),8) if all(isinstance(w["cost_usd"],(float,int)) for w in workers) else None,
        "backend": next(iter({row.get("backend","meta") for row in allrows})),
        "median_episode_sec":round(statistics.median(row["elapsed_sec"] for row in allrows),2),
        "failures":dict(sorted(errors.items(),key=lambda x:-x[1])),
        "workers":workers,"raw_logs_sha256":hashes,
        "note":"Meta Muse + reconstructed native ref-grounded controller + Mecord provider. No production relay or full TaskOrchestrator/AgentKernel claim."}
out=args.results/f"native_{args.limit}_seed{args.seed}_AUDITED.json"
with out.open("x",encoding="utf8") as f:json.dump(result,f,indent=2)
print("NATIVE_AUDIT="+json.dumps(result),flush=True)
