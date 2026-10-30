"""Explicitly isolate one-task debugging from frozen ranked campaigns."""
def plan_tasks(roster, limit, workers, worker, task_id=None):
    if (type(roster) is not list or len(roster)!=125 or len(set(roster))!=125 or
        any(type(v) is not str or not v.startswith("browsergym/miniwob.") for v in roster) or
        type(limit) is not int or not 1<=limit<=125 or
        type(workers) is not int or not 1<=workers<=4 or
        type(worker) is not int or not 0<=worker<workers):
        raise ValueError("CANONICAL_PLAN_INVALID")
    debug=task_id is not None
    if debug:
        if type(task_id) is not str or task_id not in roster or workers!=1 or worker!=0:
            raise ValueError("SINGLE_TASK_DEBUG_INVALID")
        full=[(0,task_id)]
    else:
        indices=list(range(125)) if limit==125 else (
            [round(i*124/(limit-1)) for i in range(limit)] if limit>1 else [0])
        full=[(i,roster[k]) for i,k in enumerate(indices)]
    return full,[row for row in full if row[0]%workers==worker],debug
