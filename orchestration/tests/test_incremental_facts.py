"""Real PostgreSQL regressions for exact incremental facts, including old-data corrections.

An isolated database and a copied dbt project keep this independent of developer data and
other dbt invocations. The same fixture runs in CI's disposable PostgreSQL service.
"""

import json
import os
import shutil
import uuid
from contextlib import closing
from pathlib import Path

import psycopg2
import pytest
from dbt.cli.main import dbtRunner
from psycopg2 import sql
import yaml

PROJECT = Path(__file__).resolve().parents[2] / "transformation"
FACTS = ("erc20_transfers", "dex_trades", "oracle_prices", "token_prices")


@pytest.fixture
def fact_project(tmp_path, monkeypatch):
    names = ("WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD")
    if not all(os.environ.get(name) for name in names):
        pytest.skip("set WAREHOUSE_HOST/PORT/USER/PASSWORD to run PostgreSQL model regressions")
    settings = dict(zip(("host", "port", "user", "password"), (os.environ[name] for name in names)))
    try:
        admin = psycopg2.connect(**settings, dbname="postgres")
    except psycopg2.OperationalError:
        if os.environ.get("CI"):
            raise
        pytest.skip("PostgreSQL is unavailable")
    admin.autocommit = True
    database = f"bj_facts_{uuid.uuid4().hex[:12]}"
    project = tmp_path / "transformation"
    shutil.copytree(PROJECT, project, ignore=shutil.ignore_patterns("target", "logs", "dbt_packages"))
    with closing(admin), admin.cursor() as cursor:
        cursor.execute(sql.SQL("create database {}").format(sql.Identifier(database)))
        monkeypatch.setenv("WAREHOUSE_DB", database)
        monkeypatch.setenv("RAW_SCHEMA", "raw")
        monkeypatch.setenv("DBT_SCHEMA", "analytics")
        try:
            with closing(psycopg2.connect(**settings, dbname=database)) as connection:
                connection.autocommit = True
                with connection.cursor() as query:
                    query.execute("create schema raw")
                    # Raw tables selected by the four facts; unrelated sources need no fixture.
                    tables = [
                        *(f"{chain}_erc20_transfers" for chain in ("ethereum", "arbitrum", "base")),
                        *(f"{chain}_chainlink_price_feeds" for chain in ("ethereum", "arbitrum", "base")),
                        *(f"ethereum_uniswap_v{version}" for version in (2, 3, 4)),
                        "binance_candles", "coinbase_candles",
                    ]
                    for table in tables:
                        query.execute(sql.SQL("create table raw.{} (id text primary key, data jsonb not null, "
                                              "_loaded_at timestamptz not null default now())").format(sql.Identifier(table)))
                yield project, connection
        finally:
            cursor.execute(sql.SQL("drop database {} with (force)").format(sql.Identifier(database)))


def dbt(project, command, *arguments, success=True):
    result = dbtRunner().invoke([
        command, "--quiet", "--project-dir", str(project), "--profiles-dir", str(project),
        "--no-send-anonymous-usage-stats", *arguments,
    ])
    assert result.success is success, result.exception or result.result
    return result


def put(connection, table, identifier, data):
    with connection.cursor() as query:
        # Deliberately preserve the timestamp on correction. SQL results, not a timestamp heuristic,
        # decide whether the row changed; the ingestion transaction clock is not commit ordered.
        query.execute(sql.SQL("insert into raw.{} (id, data, _loaded_at) values (%s, %s, '2020-01-01') "
                              "on conflict (id) do update set data = excluded.data").format(sql.Identifier(table)),
                      (identifier, json.dumps(data)))


def snapshot(connection):
    with connection.cursor() as query:
        result = {}
        for table in FACTS:
            query.execute(sql.SQL("select to_jsonb(t) from analytics.{} t order by to_jsonb(t)::text").format(sql.Identifier(table)))
            result[table] = query.fetchall()
        return result


def populate_facts(connection):
    transfer = dict(block_number=100, timestamp="2020-01-01", tx_hash="0xtx", log_index=0,
                    token="0xTOKEN", **{"from": "0xA", "to": "0xB"}, value="123456789012345678901234567890")
    put(connection, "ethereum_erc20_transfers", "100:0", transfer)
    put(connection, "ethereum_erc20_transfers", "100:1", {**transfer, "log_index": 1})
    candle = dict(symbol="ETHUSDT", base_asset="ETH", quote_asset="USDT", interval="1h",
                  open_time=0, close_time=3599999, open="10", high="12", low="9", close="11", volume="7",
                  quote_volume="77", trades=3, taker_buy_base_volume="2", taker_buy_quote_volume="22")
    put(connection, "binance_candles", "ETHUSDT:1h:0", candle)
    put(connection, "coinbase_candles", "ETH-USD:1h:0", {**candle, "product_id": "ETH-USD", "quote_asset": "USD"})
    log = dict(kind="log", block_number=100, timestamp="2020-01-01", tx_hash="0xtx", log_index=0,
               contract="0xPOOL")
    put(connection, "ethereum_uniswap_v3", "pool", {**log, "event": "PoolCreated",
        "args": {"pool": "0xPOOL", "token0": "0xA", "token1": "0xB", "fee": "3000", "tickSpacing": "60"}})
    put(connection, "ethereum_uniswap_v3", "swap", {**log, "log_index": 1, "event": "Swap",
        "args": {"sender": "0xA", "recipient": "0xB", "amount0": "-10", "amount1": "20"}})
    aggregator = "0x7d4e742018fb52e48b08be73d041c18b21de6fb5"
    put(connection, "ethereum_chainlink_price_feeds", "round", {**log, "contract": aggregator,
        "args": {"current": "123456789", "roundId": "1", "updatedAt": "1577836800"}})
    return transfer, candle, log, aggregator


def correct_history(connection, transfer, candle, log, aggregator):
    # An old late row, same-timestamp data correction, removed row, changed dimensional seed and
    # corrected pool metadata must all propagate without --full-refresh.
    put(connection, "ethereum_erc20_transfers", "1:0", {**transfer, "block_number": 1})
    put(connection, "ethereum_erc20_transfers", "100:0", {**transfer, "value": "7"})
    put(connection, "binance_candles", "ETHUSDT:1h:0", {**candle, "close": "12"})
    put(connection, "ethereum_uniswap_v3", "pool", {**log, "event": "PoolCreated",
        "args": {"pool": "0xPOOL", "token0": "0xC", "token1": "0xB", "fee": "3000", "tickSpacing": "60"}})
    with connection.cursor() as query:
        query.execute("delete from raw.coinbase_candles")
        query.execute("update analytics.chainlink_feeds set decimals=6 where aggregator=%s", (aggregator,))


@pytest.mark.parametrize("strategy", ["table", "reconcile"])
def test_facts_match_full_refresh_after_corrections(fact_project, strategy):
    project, connection = fact_project
    settings = project / "dbt_project.yml"
    config = yaml.safe_load(settings.read_text())
    config["vars"]["fact_strategy"] = strategy
    settings.write_text(yaml.safe_dump(config))
    transfer, candle, log, aggregator = populate_facts(connection)
    selection = [f"+{name}" for name in FACTS]
    dbt(project, "seed", "--select", "chainlink_feeds")
    dbt(project, "run", "--select", *selection)
    before = snapshot(connection)
    assert all(before.values()), "Each fact family must be exercised"
    with connection.cursor() as query:
        query.execute("select count(*) from pg_indexes where schemaname='analytics' and tablename='erc20_transfers'")
        assert query.fetchone()[0] == (1 if strategy == "reconcile" else 0), "Read indexes are opt-in"
        query.execute("select count(*) from pg_stats where schemaname='analytics' and tablename='erc20_transfers'")
        assert query.fetchone()[0] > 0, "Every strategy supplies current typed-column statistics"
        query.execute("select 'analytics.erc20_transfers'::regclass::oid, ctid::text from analytics.erc20_transfers where id='100:1'")
        identity = query.fetchone()
    config["vars"]["fact_indexes"] = True
    settings.write_text(yaml.safe_dump(config))
    dbt(project, "run", "--select", *FACTS)
    assert snapshot(connection) == before
    with connection.cursor() as query:
        query.execute("select 'analytics.erc20_transfers'::regclass::oid, ctid::text from analytics.erc20_transfers where id='100:1'")
        if strategy == "reconcile":
            assert query.fetchone() == identity, "No-op reconciliation must retain rows and the existing relation"

    correct_history(connection, transfer, candle, log, aggregator)
    # Select models only: seeding again would intentionally undo the dimensional correction.
    rebuilt = dbt(project, "run", "--select", *FACTS)
    if strategy == "reconcile":
        transfers = next(row for row in rebuilt.result.results if row.node.name == "erc20_transfers")
        assert transfers.adapter_response["rows_affected"] == 2  # One insertion and one correction.
    incremental = snapshot(connection)
    assert incremental != before
    assert incremental["dex_trades"][0][0]["token_bought"] == "0xc"
    assert len(incremental["token_prices"]) == 1
    with connection.cursor() as query:
        query.execute("select price from analytics.oracle_prices")
        assert str(query.fetchone()[0]) == "123.456789"
    dbt(project, "run", "--full-refresh", "--select", *FACTS)
    assert snapshot(connection) == incremental
    with connection.cursor() as query:
        query.execute("select count(*) from pg_indexes where schemaname='analytics' and tablename='erc20_transfers'")
        assert query.fetchone()[0] == (2 if strategy == "reconcile" else 1)

    # Duplicate natural keys reject the whole new snapshot; the published result survives.
    if strategy == "reconcile":
        put(connection, "binance_candles", "duplicate", {**candle, "close": "99"})
        dbt(project, "run", "--select", "token_prices", success=False)
        assert snapshot(connection) == incremental

    # Switching modes on an existing installation reuses the key/selector indexes.
    config["vars"]["fact_strategy"] = "reconcile" if strategy == "table" else "table"
    settings.write_text(yaml.safe_dump(config))
    dbt(project, "run", "--select", "erc20_transfers")
    assert snapshot(connection) == incremental
    with connection.cursor() as query:
        query.execute("select count(*) from pg_indexes where schemaname='analytics' and tablename='erc20_transfers'")
        assert query.fetchone()[0] == (1 if strategy == "reconcile" else 2)

    # Removing every source row must clear the old result, not leave an append-only remainder.
    with connection.cursor() as query:
        query.execute("select tablename from pg_tables where schemaname='raw'")
        for (table,) in query.fetchall():
            query.execute(sql.SQL("truncate raw.{}").format(sql.Identifier(table)))
    dbt(project, "run", "--select", *FACTS)
    assert snapshot(connection) == {name: [] for name in FACTS}
