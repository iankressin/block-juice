"""transformation/planted_bugs.py: the bugs it plants, how it names what became of each, and one run of it on a
small dbt project. It is not part of the pipeline package, so it loads by path."""

import importlib.util
import json
import os
import shutil
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
    ],
)
def test_code_a_rewrite_would_break_or_blow_up_gets_no_bug(sql, operator):
    assert rewrites(sql, operator) == []


def test_a_where_that_is_one_whole_line_can_go_and_one_with_more_conditions_cannot():
    assert rewrites("select 1 from t\nwhere kind = 'log'\ngroup by 1\n", "condition") == [("condition", 2, "where kind = 'log'", "(line removed)")]
    assert rewrites("select 1 from t\nwhere kind = 'log'\n    and x\n", "condition") == [("condition", 3, "and x", "(line removed)")]


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
        "Missed: the output changed and every test still passed.\n"
        "- fills:3 (bound) `a >= 1` became `a > 1`\n"
        "\n"
        "Note: 1 test(s) fail before any bug is planted, so they catch nothing: slow\n"
    )


PROJECT = {
    "dbt_project.yml": "name: sample\nversion: '1.0.0'\nprofile: transformation\nmodel-paths: [models]\n",
    "models/sources.yml": "sources:\n  - name: raw\n    schema: \"{{ env_var('RAW_SCHEMA', 'raw') }}\"\n    tables:\n      - name: things\n",
    "models/stg_things.sql": "{{ config(materialized='view') }}\nselect id, (data ->> 'amount')::numeric as amount, data ->> 'kind' as kind from {{ source('raw', 'things') }}\n",
    "models/tested.sql": "{{ config(materialized='table') }}\nselect id, amount * 2 as doubled\nfrom {{ ref('stg_things') }}\nwhere kind = 'keep'\n    and amount > 10\n",
    "models/untested.sql": "{{ config(materialized='table') }}\nselect id, amount + 1 as bumped\nfrom {{ ref('stg_things') }}\nwhere amount < 100\n",
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
    """A three-model dbt project and its raw rows, on the Postgres server .env names. planted_bugs.py makes and
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
    things = [{"id": "a", "data": {"amount": "11", "kind": "keep"}}, {"id": "b", "data": {"amount": "10", "kind": "keep"}}, {"id": "c", "data": {"amount": "50", "kind": "drop"}}]
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
        ("untested", "arithmetic", "select id, amount + 1 as bumped", "select id, amount - 1 as bumped"): ("missed", []),
        ("untested", "bound", "where amount < 100", "where amount <= 100"): ("not_exercised", []),
        ("untested", "condition", "where amount < 100", "(line removed)"): ("not_exercised", []),
        ("untested", "number", "select id, amount + 1 as bumped", "select id, amount + 2 as bumped"): ("missed", []),
        ("untested", "number", "where amount < 100", "where amount < 101"): ("not_exercised", []),
    }
    assert "1 test(s) fail before any bug is planted, so they catch nothing: unbuilt.never_passes" in printed.err
    assert "1 model(s) do not build before any bug is planted, so none was planted in them: unbuilt" in printed.err


def test_no_server_settings_is_bad_input(monkeypatch, capsys):
    for name in planted_bugs.SERVER:
        monkeypatch.delenv(name, raising=False)
    assert planted_bugs.main([]) == 1
    assert "set WAREHOUSE_HOST, WAREHOUSE_PORT, WAREHOUSE_USER, WAREHOUSE_PASSWORD" in capsys.readouterr().err
