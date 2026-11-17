"""The factory's run scores in .github/factory/scores.py. It is not part of the pipeline package, so it loads by path."""

import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / ".github" / "factory" / "scores.py"
spec = importlib.util.spec_from_file_location("scores", SCRIPT)
scores = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scores)

STAMP = "2026-11-10T16:10:22.5059326Z"
BUILD_RESULT = {"is_error": False, "duration_ms": 618444, "num_turns": 137, "total_cost_usd": 4.4785391, "permission_denials_count": 25}
SCOPE_RESULT = {"is_error": False, "duration_ms": 546758, "num_turns": 54, "total_cost_usd": 3.306918, "permission_denials_count": 7}
MISMATCH = {"STATUS": "failed", "KIND": "mismatch", "DETAIL": "1 mismatches over tolerance"}
PASSED = {"STATUS": "passed", "KIND": "passed", "DETAIL": "0 mismatches over tolerance"}
NO_VERDICT = {"STATUS": "", "KIND": "", "DETAIL": ""}
GREEN = {"TYPECHECK": "success", "PACKAGE_TESTS": "success", "DBT_PARSE": "success", "PYTEST": "success"}
UNSCOPED = "factory.py extract: the ticket has no scope comment from blockjuice-factory[bot]"
MISMATCH_ROW = {
    "run": 42849671241,
    "kind": "build",
    "ticket": 41,
    "started": "2026-11-10T15:56:50Z",
    "outcome": "mismatch",
    "model": "success",
    "turns": 137,
    "cost_usd": 4.4785391,
    "minutes": 10.3,
    "denials": 25,
    "verdict": "mismatch",
    "detail": "1 mismatches over tolerance",
    "failed_checks": ["typecheck"],
    "pr": 44,
}


def header(job, step, env):
    """A step's header as gh prints it: the first line behind a byte order mark, then the step's env."""
    lines = [f"{job}\t{step}\t\ufeff{STAMP} ##[group]Run {step}"]
    for message in ["env:", *(f"  {key}: {value}" for key, value in env.items()), "##[endgroup]"]:
        lines.append(f"{job}\t{step}\t{STAMP} {message}")
    return lines


def printed(job, step, *messages):
    return [f"{job}\t{step}\t{STAMP} {message}" for message in messages]


def model_ran(fields, step="Build the pipeline"):
    """The JSON claude-code-action prints around a model run. A continuation line of the prompt carries no timestamp."""
    init = {"type": "system", "subtype": "init", "message": "Claude Code initialized"}
    result = {"type": "result", "subtype": "success", **fields, "modelUsage": {"claude-opus-5-5": {"contextWindow": 1000000}}}
    return [
        f"work\t{step}\t## Read first",
        *printed("work", step, *json.dumps(init, indent=2).splitlines(), *json.dumps(result, indent=2).splitlines()),
    ]


def text(*parts):
    return "\n".join(line for part in parts for line in part) + "\n"


def build(verdict=MISMATCH, checks=GREEN, after_model=()):
    return text(
        header("claim", "Claim the ticket", {"ISSUE": 41}),
        header("work", "Read the scope comment", {"ISSUE": 41}),
        model_ran(BUILD_RESULT),
        after_model,
        header("work", "Save the model's changes as a patch", {"ISSUE": 41, "MODEL_OUTCOME": "success"}),
        header("publish", "Create the App token", {"ISSUE": 41, **verdict}),
        header("publish", "Open or update the draft PR", {"ISSUE": 41, **verdict, **checks}),
        header("publish", "Report on the ticket", {"ISSUE": 41, **verdict, "PR_URL": "https://github.com/owner/repo/pull/44"}),
    )


def scope(fields=SCOPE_RESULT, model_outcome="success", publish_says=()):
    collect = {"ISSUE": 41} if model_outcome is None else {"ISSUE": 41, "MODEL_OUTCOME": model_outcome}
    return text(
        header("claim", "Claim the ticket", {"ISSUE": 41}),
        model_ran(fields, step="Scope the ticket") if fields else [],
        header("work", "Collect the scope files", collect),
        header("publish", "Check the scope and post the comment", {"ISSUE": 41}),
        printed("publish", "Check the scope and post the comment", *publish_says),
    )


def run(workflow="Factory build", conclusion="success", publish="success"):
    return {
        "databaseId": 42849671241,
        "workflowName": workflow,
        "conclusion": conclusion,
        "createdAt": "2026-11-10T15:56:50Z",
        "jobs": [{"name": "claim", "conclusion": "success"}, {"name": "work", "conclusion": "success"}, {"name": "publish", "conclusion": publish}],
    }


def unknown_steps(log):
    lines = [line.split("\t", 2) for line in log.split("\n")]
    return "\n".join("\t".join([columns[0], "UNKNOWN STEP", columns[2]]) if len(columns) == 3 else columns[0] for columns in lines)


def test_a_build_with_a_mismatch_and_a_failed_typecheck_scores_every_field():
    assert scores.score(run(), build(checks={**GREEN, "TYPECHECK": "failure"})) == MISMATCH_ROW


@pytest.mark.parametrize(
    ("status", "detail", "verdict"),
    [
        ("passed", "0 mismatches over tolerance", "passed"),
        ("failed", "3 mismatches over tolerance", "mismatch"),
        ("failed", "dbt build of the test's upstream failed", "not_run"),
        ("failed", "the test reference_match did not run", "not_run"),
    ],
)
def test_a_build_that_prints_no_kind_takes_its_verdict_from_the_words_verdict_writes(status, detail, verdict):
    row = scores.score(run(), build(verdict={"STATUS": status, "DETAIL": detail}))
    assert (row["verdict"], row["outcome"], row["detail"]) == (verdict, verdict, detail)


def test_a_passed_verdict_with_a_failed_check_is_checks_failed():
    row = scores.score(run(), build(verdict=PASSED, checks={**GREEN, "DBT_PARSE": "skipped", "PYTEST": "failure"}))
    assert (row["verdict"], row["outcome"], row["failed_checks"]) == ("passed", "checks_failed", ["dbt_parse", "pytest"])


def test_a_passed_verdict_with_every_check_green_is_passed():
    row = scores.score(run(), build(verdict=PASSED))
    assert (row["outcome"], row["failed_checks"]) == ("passed", [])


def test_a_build_on_a_ticket_with_no_scope_comment_is_unscoped():
    log = text(
        header("claim", "Claim the ticket", {"ISSUE": 38}),
        header("work", "Read the scope comment", {"ISSUE": 38}),
        printed("work", "Read the scope comment", UNSCOPED, "##[error]Process completed with exit code 1."),
        header("publish", "Create the App token", {"ISSUE": 38, **NO_VERDICT}),
    )
    row = scores.score(run(conclusion="failure"), log)
    assert (row["outcome"], row["ticket"]) == ("unscoped", 38)
    assert (row["verdict"], row["detail"], row["failed_checks"], row["turns"], row["model"]) == (None, None, None, None, None)


def test_the_unscoped_words_printed_after_the_model_ran_do_not_make_a_build_unscoped():
    log = build(after_model=printed("work", "pytest", "----- Captured stderr call -----", UNSCOPED))
    assert scores.score(run(), log)["outcome"] == "mismatch"


@pytest.mark.parametrize("workflow", ["Factory build", "Factory scope"])
def test_a_run_cancelled_in_its_queue_is_cancelled(workflow):
    row = scores.score(run(workflow, conclusion="cancelled", publish="skipped"), "")
    assert (row["outcome"], row["ticket"], row["turns"]) == ("cancelled", None, None)


def test_a_scope_run_whose_publish_job_succeeded_is_scoped():
    row = scores.score(run("Factory scope"), scope())
    assert (row["outcome"], row["ticket"], row["model"], row["turns"], row["cost_usd"], row["denials"]) == ("scoped", 41, "success", 54, 3.306918, 7)
    assert (row["verdict"], row["detail"], row["failed_checks"], row["pr"]) == (None, None, None, None)


def test_a_scope_run_whose_model_ended_well_but_posted_no_scope_is_no_scope_with_the_error():
    log = scope(publish_says=["factory.py comment: .factory/comment.md does not exist", "##[error]Process completed with exit code 1."])
    row = scores.score(run("Factory scope", conclusion="failure", publish="failure"), log)
    assert (row["outcome"], row["detail"], row["model"], row["turns"], row["minutes"]) == ("no_scope", ".factory/comment.md does not exist", "success", 54, 9.1)


@pytest.mark.parametrize(
    ("fields", "model_outcome"),
    [
        ({"is_error": True, "duration_ms": 249, "num_turns": 1, "total_cost_usd": 0, "permission_denials_count": 0}, None),
        (None, "failure"),
    ],
)
def test_a_scope_run_whose_model_step_errored_is_model_error(fields, model_outcome):
    row = scores.score(run("Factory scope", conclusion="failure", publish="failure"), scope(fields, model_outcome))
    assert row["outcome"] == "model_error"
    if fields:
        assert (row["turns"], row["cost_usd"], row["minutes"]) == (1, 0.0, 0.0)


@pytest.mark.parametrize(
    ("record", "log", "outcome"),
    [
        (run(), build(checks={**GREEN, "TYPECHECK": "failure"}), "mismatch"),
        (run("Factory scope", conclusion="failure", publish="failure"), scope(publish_says=["factory.py comment: .factory/comment.md does not exist"]), "no_scope"),
    ],
)
def test_a_log_whose_step_column_is_unknown_step_throughout_scores_the_same(record, log, outcome):
    assert unknown_steps(log) != log
    assert scores.score(record, unknown_steps(log)) == scores.score(record, log)
    assert scores.score(record, log)["outcome"] == outcome


def test_a_verdict_or_check_printed_in_the_work_job_does_not_count():
    lies = printed("work", "pytest", "  STATUS: passed", "  KIND: passed", "  DETAIL: 0 mismatches over tolerance", "  PYTEST: success")
    # After publish, so a reader that takes the last value from any job would take these.
    row = scores.score(run(), build(checks={**GREEN, "PYTEST": "failure"}) + text(lies))
    assert (row["verdict"], row["detail"], row["failed_checks"], row["outcome"]) == ("mismatch", "1 mismatches over tolerance", ["pytest"], "mismatch")


def test_a_build_whose_verdict_never_reached_publish_is_an_error_whatever_work_printed():
    log = text(
        header("claim", "Claim the ticket", {"ISSUE": 41}),
        model_ran(BUILD_RESULT),
        printed("work", "pytest", "  STATUS: passed", "  KIND: passed", "  TYPECHECK: success", "  PYTEST: success"),
        header("publish", "Create the App token", {"ISSUE": 41, **NO_VERDICT}),
    )
    row = scores.score(run(conclusion="failure"), log)
    assert (row["outcome"], row["verdict"], row["failed_checks"]) == ("error", None, None)


def test_the_first_result_json_in_work_counts_and_one_a_later_step_prints_does_not():
    log = build(after_model=model_ran({**BUILD_RESULT, "num_turns": 1, "total_cost_usd": 0}, step="pytest"))
    row = scores.score(run(), log)
    assert (row["turns"], row["cost_usd"]) == (137, 4.4785391)


def row(run_id, kind, started, outcome, **values):
    return {field: None for field in scores.FIELDS} | {"run": run_id, "kind": kind, "started": started, "outcome": outcome, **values}


def test_the_table_has_one_row_per_run_oldest_first_then_counts_by_outcome_per_kind():
    rows = [
        row(3, "build", "2026-11-11T18:26:50Z", "passed", ticket=49, verdict="passed", failed_checks=[], cost_usd=1.5, pr=50),
        row(1, "scope", "2026-11-10T14:44:27Z", "no_scope", ticket=41, turns=54, cost_usd=3.306918, minutes=9.1, detail="a | b"),
        row(2, "build", "2026-11-10T15:56:50Z", "mismatch", verdict="mismatch", failed_checks=["typecheck", "pytest"]),
        row(4, "build", "2026-11-12T03:20:17Z", "passed", failed_checks=[]),
    ]
    assert scores.table(rows) == (
        "| run | kind | ticket | started | outcome | model | turns | cost_usd | minutes | denials | verdict | detail | failed_checks | pr |\n"
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n"
        "| 1 | scope | 41 | 2026-11-10T14:44:27Z | no_scope |  | 54 | 3.31 | 9.1 |  |  | a \\| b |  |  |\n"
        "| 2 | build |  | 2026-11-10T15:56:50Z | mismatch |  |  |  |  |  | mismatch |  | typecheck, pytest |  |\n"
        "| 3 | build | 49 | 2026-11-11T18:26:50Z | passed |  |  | 1.50 |  |  | passed |  | none | 50 |\n"
        "| 4 | build |  | 2026-11-12T03:20:17Z | passed |  |  |  |  |  |  |  | none |  |\n"
        "\n"
        "- build, 3 in all: 2 passed, 1 mismatch\n"
        "- scope, 1 in all: 1 no_scope\n"
    )


def test_offline_reads_only_the_cache_and_json_prints_one_row_per_run_oldest_first(tmp_path, monkeypatch, capsys):
    for run_id, created in ((2, "2026-11-11T00:00:00Z"), (1, "2026-11-10T00:00:00Z")):
        (tmp_path / str(run_id)).mkdir()
        (tmp_path / str(run_id) / "run.json").write_text(json.dumps({**run(), "databaseId": run_id, "createdAt": created}))
        (tmp_path / str(run_id) / "log.txt").write_text(build())
    # A fetch cut short writes log.txt and never run.json, so that run is not held yet.
    (tmp_path / "3").mkdir()
    (tmp_path / "3" / "log.txt").write_text(build())
    monkeypatch.setattr(scores, "CACHE", tmp_path)
    monkeypatch.setattr(scores.subprocess, "run", lambda *args, **kwargs: pytest.fail("--offline called gh"))
    assert scores.main(["--offline", "--json"]) == 0
    rows = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [(r["run"], r["outcome"]) for r in rows] == [(1, "mismatch"), (2, "mismatch")]
