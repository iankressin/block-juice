"""Plant one small bug at a time in a dbt model, rebuild it and what reads it, and see whether a test notices.
The share of planted bugs the tests catch says how much a green test run proves.

Run it from the repo root with WAREHOUSE_HOST, WAREHOUSE_PORT, WAREHOUSE_USER and WAREHOUSE_PASSWORD set to a
Postgres server whose user may create databases:

    uv run --project orchestration python transformation/planted_bugs.py

It works in a database of its own, which it creates and drops, so it reads and changes no warehouse. There it
makes an empty raw table for every dbt source, loads the rows of --rows when given, and builds a copy of the dbt
project.

With --changed-since it plants bugs only in the models whose .sql file changed since a git ref, and checks that
their tests catch them. CI runs it this way on every pull request. Exit codes: 0 done, or the check passed; 1 the
check failed; 2 the input, the server or the project is not what this needs.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from contextlib import closing
from dataclasses import asdict, dataclass
from pathlib import Path

PROJECT = Path(__file__).resolve().parent
SERVER = ("WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD")
BUGS_PER_OPERATOR = 3
BUGS_PER_MODEL = 12
# A dropped join condition can multiply rows without end. A statement this slow counts as its own outcome.
STATEMENT_TIMEOUT_SECONDS = 60
ROWS_BATCH_SIZE = 1000
GIT_TIMEOUT_SECONDS = 30
# A git pathspec, relative to the dbt project. Its * also matches a /, so it takes every folder under models/.
MODEL_FILES = "models/*.sql"
OUTCOMES = ("caught", "missed", "not_exercised", "build_error", "timeout")
MATERIALIZED = ("view", "table", "incremental")

# What a rewrite must leave alone: comments, Jinja and string literals.
SKIPPED = re.compile(r"--[^\n]*|/\*.*?\*/|\{#.*?#\}|\{\{.*?\}\}|\{%.*?%\}|'(?:[^']|'')*'", re.DOTALL)
ARITHMETIC = re.compile(r"(?<=[\w)\]]) ([-+*/]) (?=[\w(])")
COMPARE = re.compile(r"(?<![<>=!:|\-])(>=|<=|>|<)(?![>=|])")
EQUAL = re.compile(r"(?<![<>=!:|])(=|!=|<>)(?![>=])")
CLAUSE = re.compile(r"\b(on|where|select|having|when|qualify)\b")
IS_NULL = re.compile(r"\bis (not )?null\b")
NOT = re.compile(r"\bnot (?!null\b|in\b|like\b|ilike\b|exists\b|between\b|distinct\b|materialized\b)(?=[\w(])")
JOIN = re.compile(r"\b(?:(\w+)\s+)?join\b")
OTHER_JOINS = {"right", "full", "cross", "outer", "natural"}
PICK = re.compile(r"\b(min|max|greatest|least)\(")
COUNT_DISTINCT = re.compile(r"\bcount\((distinct)\b")
SELECT_DISTINCT = re.compile(r"\bselect distinct\b(?!\s+on\b)")
THEN_ELSE = re.compile(r"\bthen\b(.+?)\belse\b(.+?)\bend\b")
NUMBER = re.compile(r"(?<![\w.$:])(?:\d+e)?(\d+)(?![\w.])")
DIRECTION = re.compile(r"\b(asc|desc)\b")
CONDITION_LINE = re.compile(r"^[ \t]*(?:and|or)\b[^\n]*\n?", re.MULTILINE)
WHERE_LINE = re.compile(r"^[ \t]*where\b[^\n]*\n(?=\s*(?:group\b|order\b|having\b|limit\b|union\b|window\b|qualify\b|\)|\Z))", re.MULTILINE)
SWAPPED = {
    "+": "-", "-": "+", "*": "/", "/": "*", ">=": ">", ">": ">=", "<=": "<", "<": "<=", "=": "!=", "!=": "=", "<>": "=",
    "min": "max", "max": "min", "greatest": "least", "least": "greatest", "asc": "desc", "desc": "asc",
}  # fmt: skip

Edit = tuple[int, int, str]


class Invalid(Exception):
    """The input, the server or the project is not what this script needs. main prints it and exits 2."""


@dataclass(frozen=True)
class Bug:
    model: str
    operator: str
    line: int
    before: str
    after: str
    sql: str


@dataclass(frozen=True)
class Planted:
    """One run: the models it planted bugs in, those of them that did not build before any bug, one result per
    bug, and notes on what the run left out."""

    models: list[str]
    unbuilt: list[str]
    results: list[dict]
    notes: list[str]


def masked(sql: str) -> str:
    """The SQL with comments, Jinja and string literals blanked, at the same offsets."""
    return SKIPPED.sub(lambda match: re.sub(r"[^\n]", " ", match[0]), sql)


def arithmetic(code: str, sql: str) -> list[Edit]:
    """Swap + with - and * with /. The * of `select *` and `count(*)` is no product and stays."""
    edits = []
    for match in ARITHMETIC.finditer(code):
        star = match[1] == "*" and (re.search(r"\b(select|distinct)\Z", code[: match.start() - 1]) or re.match(r" from\b", code[match.end(1) :]))
        if not star:
            edits.append((match.start(1), match.end(1), SWAPPED[match[1]]))
    return edits


def bound(code: str, sql: str) -> list[Edit]:
    return [(m.start(1), m.end(1), SWAPPED[m[1]]) for m in COMPARE.finditer(code)]


def negation(code: str, sql: str) -> list[Edit]:
    """Turn a test into its opposite: = and !=, `is null` and `is not null`, and a dropped `not`. An = in a
    join's `on` stays: its opposite pairs every row with every other, which no real bug does."""
    edits = []
    for match in EQUAL.finditer(code):
        clauses = CLAUSE.findall(code[: match.start()])
        if clauses and clauses[-1] != "on":
            edits.append((match.start(1), match.end(1), SWAPPED[match[1]]))
    edits += [(m.start(), m.end(), "is null" if m[1] else "is not null") for m in IS_NULL.finditer(code)]
    edits += [(m.start(), m.end(), "") for m in NOT.finditer(code)]
    return sorted(edits)


def condition(code: str, sql: str) -> list[Edit]:
    """Drop one `and` or `or` line, or a `where` that is one whole line. A line that opens or closes a
    parenthesis stays, and so does the `and` of a `between` that started on an earlier line, since dropping
    either leaves SQL that cannot run."""
    edits = []
    for match in [*CONDITION_LINE.finditer(code), *WHERE_LINE.finditer(code)]:
        line, before = match[0], code[: match.start()]
        open_between = re.search(r"\bbetween\b(?:(?!\band\b).)*\Z", before, re.DOTALL)
        if line.count("(") == line.count(")") and not open_between:
            edits.append((match.start(), match.end(), ""))
    return sorted(edits)


def join(code: str, sql: str) -> list[Edit]:
    edits = []
    for match in JOIN.finditer(code):
        kind = (match[1] or "").lower()
        if kind == "inner":
            edits.append((match.start(1), match.end(1), "left"))
        elif kind == "left":
            edits.append((match.start(1), match.end(1), "inner"))
        elif kind not in OTHER_JOINS:
            edits.append((match.end() - len("join"), match.end(), "left join"))
    return edits


def pick(code: str, sql: str) -> list[Edit]:
    """Swap min with max, greatest with least and asc with desc, and drop a `distinct`."""
    edits = [(m.start(1), m.end(1), SWAPPED[m[1]]) for m in [*PICK.finditer(code), *DIRECTION.finditer(code)]]
    # The blank after the word goes with it only when it is a blank in the SQL too, not a blanked comment.
    edits += [(m.start(1), m.end(1) + (sql[m.end(1)] == " "), "") for m in COUNT_DISTINCT.finditer(code)]
    edits += [(m.start(), m.end(), "select") for m in SELECT_DISTINCT.finditer(code)]
    return sorted(edits)


def branch(code: str, sql: str) -> list[Edit]:
    """Swap the two results of a one-line `then … else … end`. A second `when` between them stays out: the
    swap would not parse."""
    edits = []
    for match in THEN_ELSE.finditer(code):
        if "\n" not in match[0] and not re.search(r"\bwhen\b", match[1]):
            (then, then_end), (otherwise, otherwise_end) = match.span(1), match.span(2)
            edits.append((then, otherwise_end, sql[otherwise:otherwise_end] + sql[then_end:otherwise] + sql[then:then_end]))
    return edits


def number(code: str, sql: str) -> list[Edit]:
    """Add one to a number, or to the exponent of one written like 1e6. The column positions of a `group by`
    or an `order by` are no amounts and stay."""
    edits = []
    for match in NUMBER.finditer(code):
        line = code[code.rfind("\n", 0, match.start()) + 1 : match.start()]
        if not re.match(r"\s*(group|order) by\b", line):
            edits.append((match.start(1), match.end(1), str(int(match[1]) + 1)))
    return edits


OPERATORS = {"arithmetic": arithmetic, "bound": bound, "negation": negation, "condition": condition, "join": join, "pick": pick, "branch": branch, "number": number}


def spread(items: list, limit: int) -> list:
    """At most `limit` items, evenly spaced, the same ones every run."""
    assert limit > 0
    if len(items) <= limit:
        return items
    return [items[index * len(items) // limit] for index in range(limit)]


def bugs(model: str, sql: str, per_operator: int = BUGS_PER_OPERATOR, per_model: int = BUGS_PER_MODEL) -> list[Bug]:
    """The bugs to plant in one model: each is the model's SQL with one small rewrite, outside comments, Jinja
    and strings."""
    code = masked(sql)
    assert len(code) == len(sql)
    found = []
    for name, operator in OPERATORS.items():
        for start, end, replacement in spread(operator(code, sql), per_operator):
            rewritten = sql[:start] + replacement + sql[end:]
            line = sql.count("\n", 0, start) + 1
            before = sql.split("\n")[line - 1].strip()
            after = "(line removed)" if name == "condition" else rewritten.split("\n")[line - 1].strip()
            found.append(Bug(model, name, line, before, after, rewritten))
    return spread(found, per_model)


def outcome(baseline: dict[str, str], run: dict[str, tuple[str, str]] | None, same_output: bool) -> tuple[str, list[str]]:
    """What became of one planted bug, and the tests that caught it. `baseline` and `run` map each dbt node to
    its status before and after the bug; `run` also holds the node's message, and is None when dbt could not
    start the build. A test catches a bug when it passed or only warned before, and fails or
    errors now."""
    if run is None:
        return "build_error", []
    broken = [message for node, (status, message) in run.items() if node.startswith("model.") and status == "error"]
    if broken:
        return ("timeout" if any("statement timeout" in message for message in broken) else "build_error"), []
    caught = sorted(
        node.split(".", 2)[-1]
        for node, (status, _) in run.items()
        if node.startswith(("test.", "unit_test.")) and status in ("fail", "error") and baseline.get(node) in ("pass", "warn")
    )
    if caught:
        return "caught", caught
    return ("not_exercised" if same_output else "missed"), []


def rate(counts: dict[str, int]) -> str:
    """The share of caught bugs among the caught and the missed: the ones that built and that a test or a
    change in the rows could tell from the model as written."""
    silent = counts["caught"] + counts["missed"]
    return f"{100 * counts['caught'] // silent}%" if silent else ""


def described(result: dict) -> str:
    return f"{result['model']}:{result['line']} ({result['operator']}) `{result['before']}` became `{result['after']}`"


def table(results: list[dict], notes: list[str]) -> str:
    """Markdown: one row per model, a total, each missed bug with its line and rewrite, then the notes."""
    models = sorted({result["model"] for result in results})
    lines = ["| model | planted | " + " | ".join(OUTCOMES) + " | catch rate |", "|---|" + "---|" * (len(OUTCOMES) + 2)]
    for name in [*models, None]:
        rows = [result for result in results if name is None or result["model"] == name]
        counts = {kind: sum(result["outcome"] == kind for result in rows) for kind in OUTCOMES}
        lines.append(f"| {name or '**all**'} | {len(rows)} | " + " | ".join(str(counts[kind]) for kind in OUTCOMES) + f" | {rate(counts)} |")
    missed = [result for result in results if result["outcome"] == "missed"]
    if missed:
        lines += ["", "Missed: the output changed, and no test that passed or only warned before failed."]
        lines += [f"- {described(result)}" for result in missed]
    if notes:
        lines += ["", *(f"Note: {note}" for note in notes)]
    return "\n".join(lines) + "\n"


def check(planted: Planted) -> list[str]:
    """Why the models fail the check: one Markdown item for each model that fails, none when all pass. A model
    fails when it does not build before any bug, when a bug changes the output and no test catches it, or when
    no test catches any bug that runs in it. A model with no place for a bug passes, and so does one whose every
    bug breaks the build or times out, since no test could catch those."""
    failures = []
    for name in planted.models:
        mine = [result for result in planted.results if result["model"] == name]
        missed = [result for result in mine if result["outcome"] == "missed"]
        unexercised = [result for result in mine if result["outcome"] == "not_exercised"]
        if name in planted.unbuilt:
            failures.append(f"- {name} does not build before any bug is planted. Fix it, or the unit test that fails on it: dbt skips a model whose unit test fails.")
        elif missed:
            failures.append(f"- {name}: these bugs change the output and no test catches them. Write unit tests that fail under them:" + "".join(f"\n  - {described(result)}" for result in missed))
        elif unexercised and not any(result["outcome"] == "caught" for result in mine):
            failures.append(f"- {name}: no test catches any bug planted in it. Write a unit test that fails under one of these:" + "".join(f"\n  - {described(result)}" for result in unexercised))
    return failures


def changed_models(base: str) -> list[str]:
    """The model files, relative to the dbt project, that the working tree adds or changes since the commit where
    HEAD left `base`, new files git does not track yet included. A deleted model is gone, so it does not count."""
    found = []
    for command in (
        ["git", "diff", "--name-only", "--relative", "--diff-filter=d", "--merge-base", base, "--", MODEL_FILES],
        ["git", "ls-files", "--others", "--exclude-standard", "--", MODEL_FILES],
    ):
        listed = subprocess.run(command, cwd=PROJECT, capture_output=True, text=True, timeout=GIT_TIMEOUT_SECONDS)
        if listed.returncode:
            raise Invalid(f"git cannot list the models changed since {base}: {' '.join(listed.stderr.split())}")
        found += listed.stdout.splitlines()
    return sorted(found)


def dbt(project: Path, *arguments: str):
    from dbt.cli.main import dbtRunner

    return dbtRunner().invoke([
        *arguments, "--project-dir", str(project), "--profiles-dir", str(project), "--target-path", str(project / "target"),
        "--no-send-anonymous-usage-stats", "--quiet", "--log-level", "none",
    ])  # fmt: skip


def statuses(result) -> dict[str, tuple[str, str]] | None:
    """Each node's status and message after a build, or None when dbt stopped before it ran any node."""
    if result.result is None or not hasattr(result.result, "results"):
        return None
    return {r.node.unique_id: (str(getattr(r.status, "value", r.status)), " ".join(str(r.message or "").split())) for r in result.result.results}


def fingerprints(connection, relations: dict[str, tuple[str, str]]) -> dict[str, tuple[int, str | None]]:
    """The row count and a hash of the rows of each relation, whatever their order."""
    from psycopg2 import sql

    found = {}
    with connection.cursor() as cursor:
        for node, (schema, name) in relations.items():
            cursor.execute(
                sql.SQL("select count(*), md5(string_agg(row_hash, '' order by row_hash)) from (select md5(r::text) as row_hash from {} r) hashed").format(
                    sql.Identifier(schema, name)
                )
            )
            found[node] = cursor.fetchone()
    return found


def load_raw(connection, manifest: dict, rows: Path | None) -> None:
    """An empty raw table for every dbt source, then the rows of each <table>.jsonl in `rows`: one JSON object a
    line, with `id` and `data`."""
    from psycopg2 import sql
    from psycopg2.extras import Json, execute_values

    tables = {source["identifier"]: source["schema"] for source in manifest["sources"].values()}
    with connection.cursor() as cursor:
        for schema in sorted(set(tables.values())):
            cursor.execute(sql.SQL("create schema if not exists {}").format(sql.Identifier(schema)))
        for name, schema in tables.items():
            cursor.execute(
                sql.SQL("create table {} (id text primary key, data jsonb not null, _loaded_at timestamptz not null default now())").format(
                    sql.Identifier(schema, name)
                )
            )
        for path in sorted(rows.glob("*.jsonl")) if rows else []:
            if path.stem not in tables:
                raise Invalid(f"{path} names no dbt source table; the sources are {', '.join(sorted(tables))}")
            insert = sql.SQL("insert into {} (id, data) values %s").format(sql.Identifier(tables[path.stem], path.stem))
            batch = []
            with path.open(encoding="utf-8") as lines:
                for number_, line in enumerate(lines, 1):
                    try:
                        row = json.loads(line)
                        batch.append((row["id"], Json(row["data"])))
                    except (ValueError, KeyError, TypeError):
                        raise Invalid(f"{path}:{number_} is not a JSON object with id and data") from None
                    if len(batch) == ROWS_BATCH_SIZE:
                        execute_values(cursor, insert, batch)
                        batch = []
            if batch:
                execute_values(cursor, insert, batch)
    connection.commit()


def plant(project: Path, connection, manifest: dict, names: list[str], per_operator: int, per_model: int, say) -> Planted:
    """Build the whole project once as it is, then plant each bug, rebuild its model and everything
    downstream, and record what the tests and the output did. The notes say what the run left out: a test
    that fails before any bug catches none, a model that does not build gets none, and a model may have no
    place for one."""
    import psycopg2

    models = {node["name"]: node for node in manifest["nodes"].values() if node["resource_type"] == "model"}
    relations = {uid: (node["schema"], node["alias"]) for uid, node in manifest["nodes"].items() if node["resource_type"] == "model" and node["config"]["materialized"] in MATERIALIZED}
    # The whole project, so every relation a later rebuild reads is there.
    first = statuses(dbt(project, "build", "--full-refresh"))
    if first is None or any(node.startswith("model.") and status == "error" for node, (status, _) in first.items()):
        failed = [f"{node}: {message}" for node, (status, message) in (first or {}).items() if node.startswith("model.") and status == "error"][:3]
        raise Invalid("the project does not build before any bug is planted: " + ("; ".join(failed) or "dbt could not start"))
    baseline = {node: status for node, (status, _) in first.items()}
    built = {node: relations[node] for node, status in baseline.items() if node in relations and status == "success"}
    clean = fingerprints(connection, built)
    connection.commit()
    failing = sorted(node.split(".", 2)[-1] for node, status in baseline.items() if node.startswith(("test.", "unit_test.")) and status in ("fail", "error"))
    unbuilt = sorted(name for name in names if baseline.get(models[name]["unique_id"], "success") != "success")
    notes = []
    if failing:
        notes.append(f"{len(failing)} test(s) fail before any bug is planted, so they catch nothing: {', '.join(failing)}")
    if unbuilt:
        notes.append(f"{len(unbuilt)} model(s) do not build before any bug is planted, so none was planted in them: {', '.join(unbuilt)}")
    say(f"built {len(built)} models")
    for note in notes:
        say(note)
    results, empty = [], []
    for name in names:
        if name in unbuilt:
            continue
        path = project / models[name]["original_file_path"]
        authored = path.read_text(encoding="utf-8")
        planted = bugs(name, authored, per_operator, per_model)
        if not planted:
            empty.append(name)
        for bug in planted:
            path.write_text(bug.sql, encoding="utf-8")
            run = statuses(dbt(project, "build", "--full-refresh", "--select", f"{name}+"))
            rebuilt = {node: built[node] for node in (run or {}) if node in built and run[node][0] == "success"}
            try:
                same = run is not None and fingerprints(connection, rebuilt) == {node: clean[node] for node in rebuilt}
                connection.commit()
            except psycopg2.Error as error:
                # A view runs its query when it is read, so a bug in one can build and then fail here.
                connection.rollback()
                same, run = False, {**run, models[name]["unique_id"]: ("error", " ".join(str(error).split()))}
            kind, tests = outcome(baseline, run, same)
            results.append({**{key: value for key, value in asdict(bug).items() if key != "sql"}, "outcome": kind, "caught_by": tests})
        path.write_text(authored, encoding="utf-8")
        if planted:
            restored = statuses(dbt(project, "build", "--full-refresh", "--select", f"{name}+"))
            rebuilt = {node: built[node] for node in (restored or {}) if node in built}
            if restored is None or fingerprints(connection, rebuilt) != {node: clean[node] for node in rebuilt}:
                raise Invalid(f"{name} and what reads it do not rebuild to the same rows twice, so its results mean nothing")
            connection.commit()
        counts = {kind: sum(r["model"] == name and r["outcome"] == kind for r in results) for kind in OUTCOMES}
        say(", ".join([f"{name}: {len(planted)} planted", *(f"{count} {kind}" for kind, count in counts.items() if count)]))
    if empty:
        notes.append(f"{len(empty)} model(s) have no place for a bug: {', '.join(empty)}")
        say(notes[-1])
    return Planted(names, unbuilt, results, notes)


def run(select: list[str], rows: Path | None, per_operator: int, per_model: int, say) -> Planted:
    import psycopg2
    from psycopg2 import sql

    missing = [name for name in SERVER if not os.environ.get(name)]
    if missing:
        raise Invalid(f"set {', '.join(missing)} to a Postgres server whose user may create databases")
    if rows is not None and not rows.is_dir():
        raise Invalid(f"{rows} is not a folder of <table>.jsonl files")
    settings = dict(zip(("host", "port", "user", "password"), (os.environ[name] for name in SERVER)))
    database = f"planted_bugs_{uuid.uuid4().hex[:12]}"
    try:
        admin = psycopg2.connect(**settings, dbname="postgres")
    except psycopg2.OperationalError as error:
        raise Invalid(f"no Postgres server at {settings['host']}:{settings['port']}: {' '.join(str(error).split())}") from None
    admin.autocommit = True
    with closing(admin), admin.cursor() as cursor, tempfile.TemporaryDirectory(prefix="planted-bugs-") as folder:
        cursor.execute(sql.SQL("create database {}").format(sql.Identifier(database)))
        try:
            os.environ.update(WAREHOUSE_DB=database, RAW_SCHEMA="raw", DBT_SCHEMA="analytics", PGOPTIONS=f"-c statement_timeout={STATEMENT_TIMEOUT_SECONDS * 1000}")
            project = Path(folder) / "transformation"
            shutil.copytree(PROJECT, project, ignore=shutil.ignore_patterns("target", "logs", "dbt_packages", ".user.yml", "__pycache__"))
            if not dbt(project, "parse").success:
                raise Invalid("dbt parse failed on the project")
            manifest = json.loads((project / "target" / "manifest.json").read_text(encoding="utf-8"))
            listed = dbt(project, "ls", "--resource-type", "model", "--output", "name", *(["--select", *select] if select else []))
            names = sorted(listed.result or []) if listed.success else []
            if not names:
                raise Invalid(f"no model matches {' '.join(select) or 'the project'}")
            with closing(psycopg2.connect(**settings, dbname=database)) as connection:
                load_raw(connection, manifest, rows)
                return plant(project, connection, manifest, names, per_operator, per_model, say)
        finally:
            cursor.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(database)))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="planted_bugs.py", description=__doc__.split("\n\n")[0])
    chosen = parser.add_mutually_exclusive_group()
    chosen.add_argument("--select", nargs="+", default=[], metavar="SELECTOR", help="dbt selectors for the models to plant bugs in; every model when left out")
    chosen.add_argument(
        "--changed-since", metavar="REF",
        help="plant bugs only in the models whose .sql file changed since HEAD left the git ref REF, and exit 1 when their tests prove nothing about them",
    )  # fmt: skip
    parser.add_argument("--rows", type=Path, help="a folder of <raw table>.jsonl files to load, one {id, data} object a line; the raw tables stay empty without it")
    parser.add_argument("--per-operator", type=int, default=BUGS_PER_OPERATOR, help=f"bugs of one kind in one model, at most (default {BUGS_PER_OPERATOR})")
    parser.add_argument("--per-model", type=int, default=BUGS_PER_MODEL, help=f"bugs in one model, at most (default {BUGS_PER_MODEL})")
    parser.add_argument("--json", action="store_true", help="print one JSON object per planted bug instead of the table")
    args = parser.parse_args(argv)
    if args.per_operator < 1 or args.per_model < 1:
        parser.error("--per-operator and --per-model must be at least 1")
    # The check's verdict goes after the table, or out of the way of the JSON lines.
    verdict = sys.stderr if args.json else sys.stdout
    try:
        select = args.select
        if args.changed_since is not None:
            select = [f"path:{path}" for path in changed_models(args.changed_since)]
            if not select:
                print(f"No model changed since {args.changed_since}, so the check plants no bug and passes.", file=verdict)
                return 0
        planted = run(select, args.rows, args.per_operator, args.per_model, lambda text: print(f"planted_bugs.py: {text}", file=sys.stderr, flush=True))
    except Invalid as error:
        print(f"planted_bugs.py: {error}", file=sys.stderr)
        return 2
    sys.stdout.write("".join(json.dumps(result) + "\n" for result in planted.results) if args.json else table(planted.results, planted.notes))
    if args.changed_since is None:
        return 0
    failures = check(planted)
    if failures:
        print("\nThe check fails for these changed models:\n\n" + "\n".join(failures), file=verdict)
        return 1
    print(f"\nThe check passes for {', '.join(planted.models)}.", file=verdict)
    return 0


if __name__ == "__main__":
    sys.exit(main())
