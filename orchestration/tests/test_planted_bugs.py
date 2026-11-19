"""transformation/planted_bugs.py: the bugs it plants, how it names what became of each, and one run of it on a
small dbt project. It is not part of the pipeline package, so it loads by path."""

import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path

import psycopg2
import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "transformation" / "planted_bugs.py"
spec = importlib.util.spec_from_file_location("planted_bugs", SCRIPT)
planted_bugs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planted_bugs)

MODEL = """\
-- Fills over 10 shares. A sell is not a buy - see the notes.
{%- set columns -%} id, side {%- endset %}
with fills as (
    select {{ columns }}, count(*) as n from {{ ref('stg_fills') }} where kind = 'a - b'
)

select
    f.id,
    f.shares / 1e6 as shares,
    f.usdc + f.fee as cost,
    case when f.side = 0 then 'buy' else 'sell' end as side,
    max(f.block_number) as last_block
from fills as f
inner join tokens as t on t.token_id = f.token_id
where not f.is_taker_order
    and f.shares >= 10
    and f.price is not null
group by 1
order by f.block_number desc
"""


def rewrites(sql, operator=None, **limits):
    limits = {"per_operator": 100, "per_model": 100, **limits}
    return [(bug.operator, bug.line, bug.before, bug.after) for bug in planted_bugs.bugs("m", sql, **limits) if operator in (None, bug.operator)]


def test_each_kind_of_bug_rewrites_the_code_it_names():
    assert rewrites(MODEL) == [
        ("arithmetic", 9, "f.shares / 1e6 as shares,", "f.shares * 1e6 as shares,"),
        ("arithmetic", 10, "f.usdc + f.fee as cost,", "f.usdc - f.fee as cost,"),
        ("bound", 16, "and f.shares >= 10", "and f.shares > 10"),
        ("negation", 4, "select {{ columns }}, count(*) as n from {{ ref('stg_fills') }} where kind = 'a - b'", "select {{ columns }}, count(*) as n from {{ ref('stg_fills') }} where kind != 'a - b'"),
        ("negation", 11, "case when f.side = 0 then 'buy' else 'sell' end as side,", "case when f.side != 0 then 'buy' else 'sell' end as side,"),
        ("negation", 15, "where not f.is_taker_order", "where f.is_taker_order"),
        ("negation", 17, "and f.price is not null", "and f.price is null"),
        ("condition", 16, "and f.shares >= 10", "(line removed)"),
        ("condition", 17, "and f.price is not null", "(line removed)"),
        ("join", 14, "inner join tokens as t on t.token_id = f.token_id", "left join tokens as t on t.token_id = f.token_id"),
        ("pick", 12, "max(f.block_number) as last_block", "min(f.block_number) as last_block"),
        ("pick", 19, "order by f.block_number desc", "order by f.block_number asc"),
        ("branch", 11, "case when f.side = 0 then 'buy' else 'sell' end as side,", "case when f.side = 0 then 'sell' else 'buy' end as side,"),
        ("number", 9, "f.shares / 1e6 as shares,", "f.shares / 1e7 as shares,"),
        ("number", 11, "case when f.side = 0 then 'buy' else 'sell' end as side,", "case when f.side = 1 then 'buy' else 'sell' end as side,"),
        ("number", 16, "and f.shares >= 10", "and f.shares >= 11"),
    ]


def test_every_bug_changes_one_line_and_leaves_comments_jinja_and_strings_alone():
    for bug in planted_bugs.bugs("m", MODEL, per_operator=100, per_model=100):
        before, after = MODEL.split("\n"), bug.sql.split("\n")
        if bug.operator == "condition":
            assert after == before[: bug.line - 1] + before[bug.line :]
        else:
            assert [number for number, (old, new) in enumerate(zip(before, after, strict=True), 1) if old != new] == [bug.line]
        for kept in ("A sell is not a buy - see the notes.", "{%- set columns -%} id, side {%- endset %}", "{{ columns }}", "{{ ref('stg_fills') }}", "'a - b'"):
            assert kept in bug.sql


@pytest.mark.parametrize(
    ("sql", "operator"),
    [
        ("select * from t\n", "arithmetic"),
        ("select count(*) as n, t.* from t\n", "arithmetic"),
        ("select 1 from a\ninner join b on b.id = a.id\n    and b.chain = a.chain\n", "negation"),
        ("select 1 from t where x between 1\n    and 2\n", "condition"),
        ("select 1 from t where (a\n    or b)\n", "condition"),
        ("select 1 from t\nwhere a\n    and b\n", "branch"),
        ("select case when a then 1 when b then 2 else 3 end\n", "branch"),
        ("select 1 from a cross join b\n", "join"),
        ("select distinct on (id) id from t\n", "pick"),
        ("select x::numeric(78), y ->> 'a1', $1 from t\n", "bound"),
        ("select a, b from t\ngroup by 1, 2\norder by 2 desc\n", "number"),
        ("select 1 from t where not /* keep */ flag\n", "negation"),
    ],
)
def test_code_a_rewrite_would_break_or_blow_up_gets_no_bug(sql, operator):
    assert rewrites(sql, operator) == []


def test_a_where_that_is_one_whole_line_can_go_and_one_with_more_conditions_cannot():
    assert rewrites("select 1 from t\nwhere kind = 'log'\ngroup by 1\n", "condition") == [("condition", 2, "where kind = 'log'", "(line removed)")]
    assert rewrites("select 1 from t\nwhere kind = 'log'\n    and x\n", "condition") == [("condition", 3, "and x", "(line removed)")]


def test_a_dropped_word_takes_no_comment_or_string_with_it():
    assert [bug.sql for bug in planted_bugs.bugs("m", "select 1 from t\nwhere not flag -- why\n") if bug.operator == "negation"] == ["select 1 from t\nwhere flag -- why\n"]
    assert [bug.sql for bug in planted_bugs.bugs("m", "select count(distinct 'x') from t\n") if bug.operator == "pick"] == ["select count('x') from t\n"]
    assert [bug.sql for bug in planted_bugs.bugs("m", "select count(distinct/* keep */'x') from t\n") if bug.operator == "pick"] == ["select count(/* keep */'x') from t\n"]


def test_the_limits_keep_the_same_evenly_spaced_bugs_every_run():
    every = rewrites(MODEL)
    two_each = rewrites(MODEL, per_operator=2)
    assert [bug for bug in two_each if bug[0] == "number"] == [every[13], every[14]]
    assert len(rewrites(MODEL, per_model=5)) == 5
    assert rewrites(MODEL, per_model=5) == rewrites(MODEL, per_model=5)
    assert planted_bugs.spread(list(range(10)), 3) == [0, 3, 6]


BASELINE = {"model.p.m": "success", "test.p.unique_m.1": "pass", "test.p.warned.2": "warn", "test.p.broken.3": "fail", "unit_test.p.m.math": "pass"}


@pytest.mark.parametrize(
    ("run", "same_output", "expected"),
    [
        (None, False, ("build_error", [])),
        ({"model.p.m": ("error", "syntax error at or near")}, False, ("build_error", [])),
        ({"model.p.m": ("error", "canceling statement due to statement timeout")}, False, ("timeout", [])),
        ({"model.p.m": ("success", ""), "test.p.unique_m.1": ("fail", ""), "unit_test.p.m.math": ("fail", "")}, False, ("caught", ["m.math", "unique_m.1"])),
        ({"model.p.m": ("skipped", ""), "unit_test.p.m.math": ("error", "")}, True, ("caught", ["m.math"])),
        ({"model.p.m": ("success", ""), "test.p.warned.2": ("fail", "")}, False, ("caught", ["warned.2"])),
        ({"model.p.m": ("success", ""), "test.p.broken.3": ("fail", ""), "test.p.unique_m.1": ("pass", "")}, False, ("missed", [])),
        ({"model.p.m": ("success", ""), "test.p.unique_m.1": ("warn", "")}, False, ("missed", [])),
        ({"model.p.m": ("success", ""), "test.p.unique_m.1": ("pass", "")}, True, ("not_exercised", [])),
    ],
)
def test_what_became_of_a_bug(run, same_output, expected):
    assert planted_bugs.outcome(BASELINE, run, same_output) == expected


def result(model, kind, **values):
    return {"model": model, "operator": "bound", "line": 3, "before": "a >= 1", "after": "a > 1", "outcome": kind, "caught_by": [], **values}


def test_the_table_counts_per_model_and_rates_only_the_bugs_that_changed_the_output():
    results = [result("fills", "caught"), result("fills", "caught"), result("fills", "missed"), result("fills", "not_exercised"), result("trades", "build_error"), result("trades", "timeout")]
    assert planted_bugs.table(results, ["1 test(s) fail before any bug is planted, so they catch nothing: slow"]) == (
        "| model | planted | caught | missed | not_exercised | build_error | timeout | catch rate |\n"
        "|---|---|---|---|---|---|---|---|\n"
        "| fills | 4 | 2 | 1 | 1 | 0 | 0 | 66% |\n"
        "| trades | 2 | 0 | 0 | 0 | 1 | 1 |  |\n"
        "| **all** | 6 | 2 | 1 | 1 | 1 | 1 | 66% |\n"
        "\n"
        "Missed: the output changed, and no test that passed or only warned before failed.\n"
        "- fills:3 (bound) `a >= 1` became `a > 1`\n"
        "\n"
        "Note: 1 test(s) fail before any bug is planted, so they catch nothing: slow\n"
    )


@pytest.mark.parametrize(
    ("results", "unbuilt", "expected"),
    [
        ([result("m", "caught"), result("m", "not_exercised"), result("m", "build_error")], [], []),
        ([], [], []),
        ([result("m", "build_error"), result("m", "timeout")], [], []),
        ([result("m", "caught"), result("other", "missed"), result("other", "not_exercised")], [], []),
        (
            [result("m", "caught"), result("m", "missed", line=7), result("m", "not_exercised")],
            [],
            ["- m: these bugs change the output and no test catches them. Write unit tests that fail under them:\n  - m:7 (bound) `a >= 1` became `a > 1`"],
        ),
        (
            [result("m", "not_exercised"), result("m", "not_exercised", line=9, operator="number", after="a >= 2"), result("m", "build_error")],
            [],
            [
                "- m: no test catches any bug planted in it. Write a unit test that fails under one of these:"
                "\n  - m:3 (bound) `a >= 1` became `a > 1`\n  - m:9 (number) `a >= 1` became `a >= 2`"
            ],
        ),
        ([], ["m"], ["- m does not build before any bug is planted. Fix it, or the unit test that fails on it: dbt skips a model whose unit test fails."]),
    ],
)
def test_what_the_check_says_of_a_changed_model(results, unbuilt, expected):
    assert planted_bugs.check(planted_bugs.Planted(["m"], unbuilt, results, [])) == expected


def git(repo, *arguments):
    subprocess.run(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", *arguments], cwd=repo, check=True, capture_output=True)


def branch_off_main(repo, files):
    """A git repo whose main holds `files`, checked out on a new branch."""
    for name, text in files.items():
        (repo / name).parent.mkdir(parents=True, exist_ok=True)
        (repo / name).write_text(text)
    git(repo, "init", "-b", "main")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "base")
    git(repo, "switch", "-c", "branch")


def test_only_the_models_the_branch_adds_or_changes_count_as_changed(tmp_path, monkeypatch):
    project = tmp_path / "transformation"
    names = ("edited", "gone", "kept", "moved", "touched_on_main")
    branch_off_main(tmp_path, {
        **{f"transformation/models/marts/{name}.sql": f"select 1 as {name}\n" for name in names},
        **{f"transformation/{path}": "select 1\n" for path in ("analyses/a.sql", "macros/m.sql", "tests/t.sql", "models/marts/_models.yml")},
    })  # fmt: skip
    git(tmp_path, "switch", "main")
    (project / "models/marts/touched_on_main.sql").write_text("select 2\n")
    git(tmp_path, "commit", "-am", "later on main")
    git(tmp_path, "switch", "branch")
    for path in ("models/marts/edited.sql", "analyses/a.sql", "macros/m.sql", "tests/t.sql", "models/marts/_models.yml"):
        (project / path).write_text("select 3\n")
    (project / "models/staging/new.sql").parent.mkdir(parents=True)
    (project / "models/staging/new.sql").write_text("select 4\n")
    git(tmp_path, "rm", "-q", "transformation/models/marts/gone.sql")
    git(tmp_path, "mv", "transformation/models/marts/moved.sql", "transformation/models/marts/renamed.sql")
    git(tmp_path, "add", "-A")
    git(tmp_path, "commit", "-m", "change")
    (project / "models/marts/kept.sql").write_text("select 5\n")
    (project / "models/marts/untracked.sql").write_text("select 6\n")
    monkeypatch.setattr(planted_bugs, "PROJECT", project)
    assert planted_bugs.changed_models("main") == [
        "models/marts/edited.sql", "models/marts/kept.sql", "models/marts/renamed.sql", "models/marts/untracked.sql", "models/staging/new.sql",
    ]  # fmt: skip


def test_a_branch_that_changes_no_model_passes_without_a_server(tmp_path, monkeypatch, capsys):
    branch_off_main(tmp_path, {"transformation/models/m.sql": "select 1\n", "transformation/macros/m.sql": "select 1\n"})
    (tmp_path / "transformation/macros/m.sql").write_text("select 2\n")
    monkeypatch.setattr(planted_bugs, "PROJECT", tmp_path / "transformation")
    for name in planted_bugs.SERVER:
        monkeypatch.delenv(name, raising=False)
    assert planted_bugs.main(["--changed-since", "main"]) == 0
    assert capsys.readouterr().out == "No model changed since main, so the check plants no bug and passes.\n"


def test_a_base_git_does_not_know_is_bad_input(capsys):
    assert planted_bugs.main(["--changed-since", "no-such-ref"]) == 2
    assert "planted_bugs.py: git cannot list the models changed since no-such-ref:" in capsys.readouterr().err


PROJECT = {
    "dbt_project.yml": "name: sample\nversion: '1.0.0'\nprofile: transformation\nmodel-paths: [models]\n",
    "models/sources.yml": "sources:\n  - name: raw\n    schema: \"{{ env_var('RAW_SCHEMA', 'raw') }}\"\n    tables:\n      - name: things\n",
    "models/stg_things.sql": "{{ config(materialized='view') }}\nselect id, (data ->> 'amount')::numeric as amount, data ->> 'kind' as kind from {{ source('raw', 'things') }}\n",
    "models/tested.sql": "{{ config(materialized='table') }}\nselect id, amount * 2 as doubled\nfrom {{ ref('stg_things') }}\nwhere kind = 'keep'\n    and amount > 10\n",
    "models/untested.sql": "{{ config(materialized='table') }}\nselect id, amount + 1 as bumped\nfrom {{ ref('stg_things') }}\nwhere amount < 100\n",
    "models/lazy.sql": "{{ config(materialized='view') }}\nselect id, 10 * amount as scaled\nfrom {{ ref('stg_things') }}\n",
    "models/unbuilt.sql": "{{ config(materialized='table') }}\nselect id, amount + 1 as bumped from {{ ref('stg_things') }}\n",
    "models/models.yml": """\
unit_tests:
  - name: keeps_and_doubles
    model: tested
    given:
      - input: ref('stg_things')
        rows:
          - {id: a, amount: 11, kind: keep}
          - {id: b, amount: 10, kind: keep}
          - {id: c, amount: 50, kind: drop}
    expect:
      rows:
        - {id: a, doubled: 22}
  - name: never_passes
    model: unbuilt
    given:
      - input: ref('stg_things')
        rows:
          - {id: a, amount: 1, kind: keep}
    expect:
      rows:
        - {id: a, bumped: 0}
""",
}


@pytest.fixture
def sample_project(tmp_path, monkeypatch):
    """A small dbt project and its raw rows, on the Postgres server .env names. planted_bugs.py makes and
    drops its own database there."""
    server = planted_bugs.SERVER
    if not all(os.environ.get(name) for name in server):
        pytest.skip(f"set {', '.join(server)} to a Postgres server, as .env.example does")
    try:
        psycopg2.connect(**dict(zip(("host", "port", "user", "password"), (os.environ[name] for name in server))), dbname="postgres").close()
    except psycopg2.OperationalError as error:
        if os.environ.get("CI"):
            raise
        pytest.skip(f"no Postgres server: {' '.join(str(error).split())}")
    project = tmp_path / "transformation"
    for name, text in PROJECT.items():
        (project / name).parent.mkdir(parents=True, exist_ok=True)
        (project / name).write_text(text)
    shutil.copy2(SCRIPT.parent / "profiles.yml", project / "profiles.yml")
    rows = tmp_path / "rows"
    rows.mkdir()
    things = [{"id": "a", "data": {"amount": "11", "kind": "keep"}}, {"id": "b", "data": {"amount": "10", "kind": "keep"}}, {"id": "c", "data": {"amount": "50", "kind": "drop"}}, {"id": "d", "data": {"amount": "0", "kind": "drop"}}]
    (rows / "things.jsonl").write_text("".join(json.dumps(thing) + "\n" for thing in things))
    monkeypatch.setattr(planted_bugs, "PROJECT", project)
    for name in ("WAREHOUSE_DB", "RAW_SCHEMA", "DBT_SCHEMA", "PGOPTIONS"):
        monkeypatch.setenv(name, os.environ.get(name, ""))
    return rows


def test_a_run_catches_bugs_a_test_covers_and_misses_the_ones_none_does(sample_project, capsys):
    assert planted_bugs.main(["--rows", str(sample_project), "--json"]) == 0
    printed = capsys.readouterr()
    results = [json.loads(line) for line in printed.out.splitlines()]
    found = {(r["model"], r["operator"], r["before"], r["after"]): (r["outcome"], r["caught_by"]) for r in results}
    caught = ("caught", ["tested.keeps_and_doubles"])
    assert found == {
        ("tested", "arithmetic", "select id, amount * 2 as doubled", "select id, amount / 2 as doubled"): caught,
        ("tested", "bound", "and amount > 10", "and amount >= 10"): caught,
        ("tested", "negation", "where kind = 'keep'", "where kind != 'keep'"): caught,
        ("tested", "condition", "and amount > 10", "(line removed)"): caught,
        ("tested", "number", "select id, amount * 2 as doubled", "select id, amount * 3 as doubled"): caught,
        ("tested", "number", "and amount > 10", "and amount > 11"): caught,
        ("lazy", "arithmetic", "select id, 10 * amount as scaled", "select id, 10 / amount as scaled"): ("build_error", []),
        ("lazy", "number", "select id, 10 * amount as scaled", "select id, 11 * amount as scaled"): ("missed", []),
        ("untested", "arithmetic", "select id, amount + 1 as bumped", "select id, amount - 1 as bumped"): ("missed", []),
        ("untested", "bound", "where amount < 100", "where amount <= 100"): ("not_exercised", []),
        ("untested", "condition", "where amount < 100", "(line removed)"): ("not_exercised", []),
        ("untested", "number", "select id, amount + 1 as bumped", "select id, amount + 2 as bumped"): ("missed", []),
        ("untested", "number", "where amount < 100", "where amount < 101"): ("not_exercised", []),
    }
    assert "1 test(s) fail before any bug is planted, so they catch nothing: unbuilt.never_passes" in printed.err
    assert "1 model(s) do not build before any bug is planted, so none was planted in them: unbuilt" in printed.err
    assert "1 model(s) have no place for a bug: stg_things" in printed.err


def test_the_check_fails_the_changed_models_whose_tests_prove_nothing(sample_project, capsys):
    project = planted_bugs.PROJECT
    branch_off_main(project.parent, {})
    for name in ("tested", "untested", "unbuilt"):
        with (project / "models" / f"{name}.sql").open("a") as model:
            model.write("-- changed on the branch\n")
    git(project.parent, "commit", "-am", "change three models")
    assert planted_bugs.main(["--changed-since", "main"]) == 1
    printed = capsys.readouterr().out
    assert "| tested | 6 | 6 | 0 | 0 | 0 | 0 | 100% |" in printed
    assert "lazy" not in printed
    assert printed.endswith(
        "The check fails for these changed models:\n\n"
        "- unbuilt does not build before any bug is planted. Fix it, or the unit test that fails on it: dbt skips a model whose unit test fails.\n"
        "- untested: no test catches any bug planted in it. Write a unit test that fails under one of these:\n"
        "  - untested:2 (arithmetic) `select id, amount + 1 as bumped` became `select id, amount - 1 as bumped`\n"
        "  - untested:4 (bound) `where amount < 100` became `where amount <= 100`\n"
        "  - untested:4 (condition) `where amount < 100` became `(line removed)`\n"
        "  - untested:2 (number) `select id, amount + 1 as bumped` became `select id, amount + 2 as bumped`\n"
        "  - untested:4 (number) `where amount < 100` became `where amount < 101`\n"
    )


def test_no_server_settings_is_bad_input(monkeypatch, capsys):
    for name in planted_bugs.SERVER:
        monkeypatch.delenv(name, raising=False)
    assert planted_bugs.main([]) == 2
    assert "set WAREHOUSE_HOST, WAREHOUSE_PORT, WAREHOUSE_USER, WAREHOUSE_PASSWORD" in capsys.readouterr().err
