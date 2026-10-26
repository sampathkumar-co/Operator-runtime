"""Strict report-only synthetic benchmark roster audit.

No network, no model calls, no browser, no file reads/writes or authorization.
This checks internally supplied result syntax and exact roster coverage, but
cannot independently prove that an external scorer produced the input.
"""
from __future__ import annotations

import math
import re
from typing import Any


class BenchmarkAuditError(ValueError):
    pass


def _literal_id(value: Any, label: str, limit: int = 128) -> str:
    if type(value) is not str or not (1 <= len(value) <= limit) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._/-]*", value
    ):
        raise BenchmarkAuditError(label + "_INVALID")
    return value


def audit_results(
    records: list[dict[str, Any]],
    expected_task_ids: list[str],
    *,
    seed: int,
    source_sha: str,
    model_id: str,
) -> dict[str, Any]:
    """Count every expected task once; never invent reward or acceptance.

    Each input record must be inert JSON-like data, task_id, seed, source_sha,
    model_id and independent_scorer_reward. The reward is *supplied* evidence,
    not authenticated by this function, so the result is ALWAYS source-only.
    """
    if (type(records) is not list or type(expected_task_ids) is not list
            or not 1 <= len(expected_task_ids) <= 125
            or len(records) > 125 or type(seed) is not int or seed < 0
            or type(source_sha) is not str or not re.fullmatch(r"[0-9a-f]{40}", source_sha)
            or type(model_id) is not str or not 1 <= len(model_id) <= 128):
        raise BenchmarkAuditError("AUDIT_CONFIGURATION_INVALID")

    roster: set[str] = set()
    for value in expected_task_ids:
        task = _literal_id(value, "EXPECTED_TASK")
        if task in roster:
            raise BenchmarkAuditError("DUPLICATE_EXPECTED_TASK")
        roster.add(task)

    observed: set[str] = set()
    successes = 0
    failed = 0
    total_calls = 0
    for record in records:
        if type(record) is not dict or set(record) != {
            "task_id", "seed", "source_sha", "model_id",
            "independent_scorer_reward", "model_calls"
        }:
            raise BenchmarkAuditError("EPISODE_SHAPE_INVALID")
        task = _literal_id(record["task_id"], "TASK")
        if task not in roster:
            raise BenchmarkAuditError("TASK_OUTSIDE_LOCKED_ROSTER")
        if task in observed:
            raise BenchmarkAuditError("DUPLICATE_TASK_RESULT")
        observed.add(task)
        if (type(record["seed"]) is not int or record["seed"] != seed
                or type(record["source_sha"]) is not str
                or record["source_sha"] != source_sha
                or type(record["model_id"]) is not str
                or record["model_id"] != model_id):
            raise BenchmarkAuditError("PINNED_EVALUATION_CONTEXT_MISMATCH")

        reward = record["independent_scorer_reward"]
        if (type(reward) not in (float, int) or not math.isfinite(reward)
                or not 0 <= reward <= 1):
            raise BenchmarkAuditError("SCORER_REWARD_INVALID")
        calls = record["model_calls"]
        if type(calls) is not int or not 0 <= calls <= 1000:
            raise BenchmarkAuditError("MODEL_CALL_COUNT_INVALID")
        total_calls += calls
        if reward == 1.0:
            successes += 1
        else:
            failed += 1

    missing = sorted(roster - observed)
    if missing:
        raise BenchmarkAuditError("ROSTER_INCOMPLETE:" + ",".join(missing[:5]))

    # A syntactically valid result cannot authenticate the official scorer.
    # The user must separately check immutable scorer/environment/model proof.
    return {
        "status": "UNVERIFIED_SOURCE_ONLY",
        "source_sha": source_sha,
        "model_id": model_id,
        "seed": seed,
        "task_count": len(roster),
        "successes": successes,
        "failures": failed,
        "model_calls": total_calls,
        "success_rate": successes / len(roster),
        "independent_scorer_authenticated": False,
        "physical_execution_verified": False,
    }
