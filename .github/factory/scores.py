"""One row per factory run: how it ended, what the model spent, and what the verdict and the repo checks said,
so a change to the prompts, the skill or the CLI shows up as runs that end better or worse.

Run it from the repo root as `uv run --project orchestration python .github/factory/scores.py`. It keeps
each finished run in .factory/runs/<run id>/ as run.json and log.txt, downloads only runs it does not hold yet,
and prints a markdown table, or JSON lines with --json. Exit codes: 0 done, 1 `gh` failed or a run's record is
not what this script reads.
"""

import argparse
import json
import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".factory" / "runs"
RUN_LIMIT = 200
GH_TIMEOUT_SECONDS = 300
RUN_FIELDS = "databaseId,workflowName,conclusion,createdAt,jobs"
WORKFLOWS = {"Factory build": "factory-build.yml", "Factory scope": "factory-scope.yml"}
KINDS = {"Factory build": "build", "Factory scope": "scope"}
JOBS = ("claim", "work", "publish")
CHECKS = ("typecheck", "package_tests", "dbt_parse", "pytest")
VERDICTS = ("passed", "mismatch", "not_run")
FIELDS = ("run", "kind", "ticket", "started", "outcome", "model", "turns", "cost_usd", "minutes", "denials", "verdict", "detail", "failed_checks", "pr")

# gh prints `job<TAB>step<TAB>timestamp message`. The first line of a step starts with a byte order mark, and the
# continuation lines of a multi-line message carry no timestamp.
STAMP = re.compile(r"^\ufeff?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?")
RESULT_LINE = '  "type": "result",'
FACTORY_ERROR = re.compile(r"^factory\.py ([a-z-]+): (.+)$")
UNSCOPED = "the ticket has no scope comment"
MISMATCH = re.compile(r"^\d+ mismatches over tolerance$")
PULL = re.compile(r"/pull/(\d+)$")


class Invalid(Exception):
    """A run's record breaks what this script reads, or gh failed. main prints it and exits 1."""


Facts = dict[str, Any]


def always(facts: Facts) -> bool:
    return True


# Order matters: the first row whose test holds names the outcome.
OUTCOMES: dict[str, list[tuple[Callable[[Facts], bool], str]]] = {
    "build": [
        (lambda f: f["conclusion"] == "cancelled", "cancelled"),
        (lambda f: f["unscoped"], "unscoped"),
        (lambda f: f["verdict"] == "passed" and f["failed_checks"] == [], "passed"),
        (lambda f: f["verdict"] == "passed" and bool(f["failed_checks"]), "checks_failed"),
        (lambda f: f["verdict"] == "mismatch", "mismatch"),
        (lambda f: f["verdict"] == "not_run", "not_run"),
        (always, "error"),
    ],
    "scope": [
        (lambda f: f["conclusion"] == "cancelled", "cancelled"),
        (lambda f: f["published"], "scoped"),
        (lambda f: f["model"] == "failure" or f["is_error"], "model_error"),
        (always, "no_scope"),
    ],
}
assert set(KINDS) == set(WORKFLOWS)
assert set(OUTCOMES) == set(KINDS.values())
assert all(rows[-1][0] is always for rows in OUTCOMES.values()), "every run must get an outcome"


def messages(log: str, job: str) -> list[str]:
    """One job's log lines, without gh's job and step columns and the timestamp. The step column reads
    `UNKNOWN STEP` on every line of some runs, so nothing here reads it."""
    assert job in JOBS
    found = []
    for line in log.split("\n"):
        columns = line.split("\t", 2)
        if len(columns) == 3 and columns[0] == job:
            found.append(STAMP.sub("", columns[2], count=1))
    return found


def env_value(lines: list[str], key: str) -> str | None:
    """The last value a step header printed for an env key. GitHub prints an empty value as `  KEY: `, which
    reads as None."""
    assert re.fullmatch(r"[A-Z_]+", key)
    prefix = f"  {key}:"
    for line in reversed(lines):
        if line.startswith(prefix):
            return line[len(prefix) :].strip() or None
    return None


def model_result(lines: list[str]) -> dict:
    """turns, cost_usd, minutes, denials and is_error from the result JSON claude-code-action prints; {} when no
    model ran. The first one counts: code the model wrote runs later in the same job and could print another."""
    if RESULT_LINE not in lines:
        return {}
    start = lines.index(RESULT_LINE) - 1
    try:
        end = lines.index("}", start)
        result = json.loads("\n".join(lines[start : end + 1]))
    except ValueError:
        raise Invalid("the model's result JSON in the work job does not parse") from None
    duration = result.get("duration_ms")
    cost = result.get("total_cost_usd")
    return {
        "turns": result.get("num_turns"),
        "cost_usd": None if cost is None else float(cost),
        "minutes": None if duration is None else round(duration / 60_000, 1),
        "denials": result.get("permission_denials_count"),
        "is_error": result.get("is_error"),
    }


def verdict_kind(status: str | None, kind: str | None, detail: str | None) -> str | None:
    """passed, mismatch or not_run, as factory.verdict names them; None when no verdict reached publish. Runs
    from before PR 37 print no KIND, so it comes from the words verdict() writes: STATUS passed is passed,
    `<n> mismatches over tolerance` is mismatch, and anything else did not run."""
    if status is None:
        return None
    if status not in ("passed", "failed"):
        raise Invalid(f"STATUS is {status}, not passed or failed")
    if kind is None:
        if status == "passed":
            return "passed"
        return "mismatch" if detail and MISMATCH.match(detail) else "not_run"
    if kind not in VERDICTS:
        raise Invalid(f"KIND is {kind}, not one of {', '.join(VERDICTS)}")
    if (kind == "passed") != (status == "passed"):
        raise Invalid(f"KIND {kind} and STATUS {status} disagree")
    return kind


def factory_errors(lines: list[str]) -> list[tuple[str, str]]:
    """The command and message of each `factory.py <command>: <message>` line, in order."""
    return [(match[1], match[2]) for match in map(FACTORY_ERROR.match, lines) if match]


def score(run: dict, log: str) -> dict:
    """The row. Pure: run is gh's JSON for one run, log is its text. The verdict and the checks come from
    `publish` lines only. The model runs in `work`, so nothing it prints can pass for them."""
    if run["workflowName"] not in KINDS:
        raise Invalid(f"{run['workflowName']} is not a factory workflow")
    kind = KINDS[run["workflowName"]]
    build = kind == "build"
    claim, work, publish = (messages(log, job) for job in JOBS)
    result = model_result(work)
    errors = factory_errors(claim + work + publish)
    issue = env_value(claim, "ISSUE")
    pull = PULL.search(env_value(publish, "PR_URL") or "")
    detail = env_value(publish, "DETAIL")
    checks = {name: env_value(publish, name.upper()) for name in CHECKS}
    reported = any(outcome is not None for outcome in checks.values())
    row = {
        "run": run["databaseId"],
        "kind": kind,
        "ticket": int(issue) if issue and issue.isdigit() else None,
        "started": run["createdAt"],
        "outcome": None,
        "model": env_value(work, "MODEL_OUTCOME"),
        "turns": result.get("turns"),
        "cost_usd": result.get("cost_usd"),
        "minutes": result.get("minutes"),
        "denials": result.get("denials"),
        "verdict": verdict_kind(env_value(publish, "STATUS"), env_value(publish, "KIND"), detail) if build else None,
        "detail": detail if build else (errors[-1][1] if errors else None),
        "failed_checks": [name for name, outcome in checks.items() if outcome != "success"] if build and reported else None,
        "pr": int(pull[1]) if pull else None,
    }
    facts = {
        **row,
        "conclusion": run["conclusion"],
        "published": any(job["name"] == "publish" and job["conclusion"] == "success" for job in run["jobs"]),
        # A build stops at extract when the ticket has no scope, before the model. A model that ran can make a
        # later step print the same words, so they count only when no model ran.
        "unscoped": not result and any(command == "extract" and message.startswith(UNSCOPED) for command, message in errors),
        "is_error": result.get("is_error") is True,
    }
    row["outcome"] = next(outcome for holds, outcome in OUTCOMES[kind] if holds(facts))
    assert tuple(row) == FIELDS
    return row


def oldest_first(row: dict) -> tuple[str, int]:
    return row["started"], row["run"]


def cell(key: str, value: Any) -> str:
    if value is None:
        return ""
    if key == "cost_usd":
        return f"{value:.2f}"
    if isinstance(value, list):
        return ", ".join(value) or "none"
    return str(value).replace("|", "\\|")


def table(rows: list[dict]) -> str:
    """Markdown: one row per run, oldest first, then one line of counts by outcome per kind."""
    lines = ["| " + " | ".join(FIELDS) + " |", "|" + "---|" * len(FIELDS)]
    lines += ["| " + " | ".join(cell(key, row[key]) for key in FIELDS) + " |" for row in sorted(rows, key=oldest_first)]
    lines.append("")
    for kind in KINDS.values():
        outcomes = [row["outcome"] for row in rows if row["kind"] == kind]
        if outcomes:
            counts = ", ".join(f"{outcomes.count(outcome)} {outcome}" for _, outcome in OUTCOMES[kind] if outcome in outcomes)
            lines.append(f"- {kind}, {len(outcomes)} in all: {counts}")
    return "\n".join(lines) + "\n"


def gh(*args: str) -> str:
    """What gh prints. A gh that fails, cannot start or takes too long raises Invalid with its message."""
    command = ["gh", *args]
    try:
        done = subprocess.run(
            command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False, timeout=GH_TIMEOUT_SECONDS
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Invalid(f"{' '.join(command)}: {error}") from None
    if done.returncode != 0:
        raise Invalid(f"{' '.join(command)}: {' '.join(done.stderr.split())}")
    return done.stdout


def run_log(jobs: list[dict]) -> str:
    """The run's log, one job at a time. `gh run view <id> --log` fails when any job has no log, and a job
    cancelled in its queue has none, though the model may have run and spent in an earlier job. A job that
    ran must have a log; a cancelled or skipped one may not."""
    parts = []
    for job in jobs:
        try:
            parts.append(gh("run", "view", "--job", str(job["databaseId"]), "--log"))
        except Invalid:
            if job["conclusion"] not in ("cancelled", "skipped"):
                raise
    return "\n".join(parts)


def fetch(cache: Path, limit: int) -> None:
    """Every call to GitHub starts here. Skips runs GitHub marks `skipped`, runs still going, and runs already
    cached: a finished run never changes. run.json lands last, by a rename, so a fetch cut short leaves a run
    the next fetch takes again."""
    assert limit > 0
    fetched = 0
    for workflow in WORKFLOWS.values():
        for run in json.loads(gh("run", "list", "--workflow", workflow, "--limit", str(limit), "--json", "databaseId,status,conclusion")):
            run_id = str(run["databaseId"])
            folder = cache / run_id
            if run["status"] != "completed" or run["conclusion"] == "skipped" or (folder / "run.json").is_file():
                continue
            record = gh("run", "view", run_id, "--json", RUN_FIELDS)
            try:
                log = run_log(json.loads(record)["jobs"])
            except Invalid as error:
                print(f"scores.py: left out run {run_id} until its log downloads: {error}", file=sys.stderr)
                continue
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "log.txt").write_text(log, encoding="utf-8")
            (folder / "run.json.tmp").write_text(record, encoding="utf-8")
            (folder / "run.json.tmp").replace(folder / "run.json")
            fetched += 1
    if fetched:
        print(f"scores.py: fetched {fetched} run(s) into {cache}", file=sys.stderr)


def cached_rows(cache: Path) -> list[dict]:
    """The row of every run the cache holds."""
    rows = []
    for path in sorted(cache.glob("*/run.json")):
        run = json.loads(path.read_text(encoding="utf-8"))
        try:
            rows.append(score(run, (path.parent / "log.txt").read_text(encoding="utf-8")))
        except Invalid as error:
            raise Invalid(f"run {run['databaseId']}: {error}") from None
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="scores.py", description=__doc__.split("\n\n")[0])
    parser.add_argument("--json", action="store_true", help="print one JSON object per run, oldest first, instead of the table")
    parser.add_argument("--offline", action="store_true", help="fetch nothing and score only the runs .factory/runs holds")
    args = parser.parse_args(argv)
    try:
        if not args.offline:
            fetch(CACHE, RUN_LIMIT)
        rows = cached_rows(CACHE)
    except Invalid as error:
        print(f"scores.py: {error}", file=sys.stderr)
        return 1
    if args.json:
        output = "".join(json.dumps(row) + "\n" for row in sorted(rows, key=oldest_first))
    else:
        output = table(rows)
    sys.stdout.write(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
