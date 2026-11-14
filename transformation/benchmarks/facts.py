"""Compare complete table builds and exact reconciliation using an isolated synthetic database.

Run with orchestration's Python environment and WAREHOUSE_HOST/PORT/USER/PASSWORD. Requires
CREATEDB on a disposable PostgreSQL server. No existing warehouse database is read or changed.
"""

import argparse
import json
import os
import shutil
import statistics
import tempfile
import uuid
from contextlib import closing
from pathlib import Path

import psycopg2
import yaml
from dbt.cli.main import dbtRunner
from psycopg2 import sql


def run(project, *arguments):
    result = dbtRunner().invoke([
        "run", "--quiet", "--project-dir", str(project), "--profiles-dir", str(project),
        "--no-send-anonymous-usage-stats", *arguments,
    ])
    if not result.success:
        raise RuntimeError(result.exception or result.result)
    return result.result.results[-1].execution_time


def tuples(connection, schema):
    with connection.cursor() as query:
        query.execute("select pg_stat_clear_snapshot()")
        query.execute("select relid, n_tup_ins, n_tup_upd, n_tup_del from pg_stat_user_tables "
                      "where schemaname=%s and relname='erc20_transfers'", (schema,))
        return query.fetchone()


def explain(connection, statement):
    with connection.cursor() as query:
        query.execute("explain (analyze, buffers, format json) " + statement)
        return query.fetchone()[0][0]


def seed_raw(connection, rows):
    with connection.cursor() as query:
        query.execute("create schema raw")
        for chain in ("ethereum", "arbitrum", "base"):
            query.execute(sql.SQL("create table raw.{} (id text primary key, data jsonb not null, "
                                  "_loaded_at timestamptz not null default now())")
                          .format(sql.Identifier(f"{chain}_erc20_transfers")))
        query.execute("""insert into raw.ethereum_erc20_transfers
            select n::text, jsonb_build_object('block_number', n, 'timestamp', '2020-01-01',
            'tx_hash', '0x' || md5(n::text), 'log_index', n %% 100,
            'token', '0xtoken' || (n %% 100)::text, 'from', '0x' || md5((n %% 1000)::text),
            'to', '0x' || md5((n %% 1001)::text), 'value', (n::numeric * 1000000000000000000)::text),
            now() from generate_series(1, %s) n""", (rows,))
        query.execute("analyze raw.ethereum_erc20_transfers")


def benchmark_dex(connection):
    report = {}
    # A typed fixture with the same predicate and columns as the UNI swap analyses isolates the
    # access path from ingestion/ABI decoding. It is not a production DEX throughput benchmark.
    with connection.cursor() as query:
        query.execute("create table bench_table.dex_index_fixture as select chain, 'v3'::text as version, "
                      "block_number, token as token_bought, from_address as token_sold from bench_table.erc20_transfers")
        query.execute("analyze bench_table.dex_index_fixture")
    dex = ("select count(*) from bench_table.dex_index_fixture where chain='ethereum' and version='v3' "
           "and block_number between 10000 and 12000 and '0xtoken42' in (token_bought, token_sold)")
    report["dex_window_before_index"] = explain(connection, dex)
    with connection.cursor() as query:
        query.execute("create index on bench_table.dex_index_fixture(chain, version, block_number)")
    report["dex_window_after_index"] = explain(connection, dex)
    return report


def benchmark(project, connection, rows, repeats):
    seed_raw(connection, rows)
    model = project / "models/marts/transfers/erc20_transfers.sql"
    authored = model.read_text()
    settings = project / "dbt_project.yml"
    config = yaml.safe_load(settings.read_text())
    strategies = ("baseline", "table", "indexed", "reconcile")
    report = {"rows": rows, "repeats": repeats, "interleaved": True, "builds": {}}

    def activate(strategy):
        # Baseline is the previous full rebuild with no indexes or ANALYZE hook.
        model.write_text("\n".join(line for line in authored.splitlines() if "{{ fact_config(" not in line)
                         if strategy == "baseline" else authored)
        config["vars"]["fact_strategy"] = "reconcile" if strategy == "reconcile" else "table"
        config["vars"]["fact_indexes"] = strategy == "indexed"
        settings.write_text(yaml.safe_dump(config))
        schema = "bench_" + strategy
        os.environ["DBT_SCHEMA"] = schema
        return schema

    # Independent schemas keep each strategy's prior result while their executions are interleaved.
    # Rotating the order reduces the bias of a shared host getting busier halfway through a run.
    for strategy in strategies:
        activate(strategy)
        run(project, "--full-refresh", "--select", "+erc20_transfers")
        report["builds"][strategy] = {}
    for scenario in ("no_op", "correct_100"):
        for strategy in strategies:
            report["builds"][strategy][scenario] = {"node_seconds": [], "target_inserts_updates_deletes": []}
        for repeat in range(repeats):
            if scenario == "correct_100":
                with connection.cursor() as query:
                    query.execute("update raw.ethereum_erc20_transfers "
                                  "set data=jsonb_set(data, '{value}', to_jsonb(%s::text)) "
                                  "where id::int <= 100", (str(repeat),))
            order = strategies[repeat % len(strategies):] + strategies[:repeat % len(strategies)]
            for strategy in order:
                schema = activate(strategy)
                old = tuples(connection, schema)
                duration = run(project, "--select", "erc20_transfers")
                current = tuples(connection, schema)
                result = report["builds"][strategy][scenario]
                result["node_seconds"].append(duration)
                result["target_inserts_updates_deletes"].append([
                    current[i] - (old[i] if old[0] == current[0] else 0) for i in (1, 2, 3)
                ])
        for strategy in strategies:
            result = report["builds"][strategy][scenario]
            result["median_seconds"] = statistics.median(result["node_seconds"])
    for strategy in strategies:
        report["builds"][strategy]["token_window_plan"] = explain(connection,
            "select * from bench_" + strategy + ".erc20_transfers where chain='ethereum' "
            "and token='0xtoken42' and block_number between 10000 and 20000")

    report.update(benchmark_dex(connection))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=200_000)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    if args.rows < 20_000 or args.repeats < 1:
        parser.error("use at least 20000 rows and one repeat")
    settings = {key: os.environ[env] for key, env in (
        ("host", "WAREHOUSE_HOST"), ("port", "WAREHOUSE_PORT"),
        ("user", "WAREHOUSE_USER"), ("password", "WAREHOUSE_PASSWORD"),
    )}
    database = f"bj_benchmark_{uuid.uuid4().hex[:12]}"
    with closing(psycopg2.connect(**settings, dbname="postgres")) as admin:
        admin.autocommit = True
        with admin.cursor() as query:
            query.execute(sql.SQL("create database {}").format(sql.Identifier(database)))
        try:
            with tempfile.TemporaryDirectory(prefix="bj_fact_benchmark_") as directory:
                project = Path(directory) / "transformation"
                shutil.copytree(Path(__file__).resolve().parents[1], project,
                                ignore=shutil.ignore_patterns("target", "logs", "dbt_packages", "__pycache__"))
                os.environ.update(WAREHOUSE_DB=database, RAW_SCHEMA="raw", DBT_SCHEMA="analytics")
                with closing(psycopg2.connect(**settings, dbname=database)) as connection:
                    connection.autocommit = True
                    print(json.dumps(benchmark(project, connection, args.rows, args.repeats), indent=2))
        finally:
            with admin.cursor() as query:
                query.execute(sql.SQL("drop database {} with (force)").format(sql.Identifier(database)))


if __name__ == "__main__":
    main()
