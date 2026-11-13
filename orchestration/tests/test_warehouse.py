import os
import uuid
from contextlib import closing

import psycopg2
import pytest
from psycopg2 import sql

from pipeline.warehouse import read_cursor

SERVER = ("WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD")


@pytest.fixture(scope="module")
def scratch():
    """A database of its own on the Postgres server .env names, dropped after the module's tests,
    so they read and write nothing of the warehouse's."""
    if not all(os.environ.get(name) for name in SERVER):
        pytest.skip(f"set {', '.join(SERVER)} to a Postgres server, as .env.example does")
    settings = dict(zip(("host", "port", "user", "password"), (os.environ[name] for name in SERVER)))
    try:
        admin = psycopg2.connect(**settings, dbname="postgres")
    except psycopg2.OperationalError as error:
        # CI starts a Postgres for these tests, so there a failed connection is a failure, not a missing server.
        if os.environ.get("CI"):
            raise
        pytest.skip(f"no Postgres server at {settings['host']}:{settings['port']}: {' '.join(str(error).split())}")
    admin.autocommit = True
    name = f"bj_test_{uuid.uuid4().hex[:12]}"
    with closing(admin), admin.cursor() as cursor:
        cursor.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
        try:
            yield {**settings, "dbname": name}
        finally:
            cursor.execute(sql.SQL("drop database {} with (force)").format(sql.Identifier(name)))


@pytest.fixture
def database(scratch, monkeypatch):
    """The scratch database with no raw schema, as warehouse.connect() reaches it. Returns a function that runs SQL in it."""
    monkeypatch.setenv("WAREHOUSE_DB", scratch["dbname"])
    monkeypatch.setenv("RAW_SCHEMA", "raw")

    def execute(statement: str) -> None:
        with closing(psycopg2.connect(**scratch)) as connection, connection, connection.cursor() as cursor:
            cursor.execute(statement)

    execute("drop schema if exists raw cascade")
    return execute


# The columns of the _sync table Pipes creates that a row cannot leave empty. Pipes saves a row per
# batch, so a stream source has several.
SYNC = "create schema raw; create table raw._sync (id text not null, current_number numeric not null, current_hash text not null)"


def test_no_cursor_before_pipes_creates_its_table(database):
    assert read_cursor("ethereum_erc20_transfers") is None


def test_the_cursor_is_the_highest_block_saved_for_the_source(database):
    database(
        SYNC + "; insert into raw._sync values"
        " ('ethereum_erc20_transfers', 150, '0xa'), ('ethereum_erc20_transfers', 180, '0xb'),"
        " ('ethereum_erc20_transfers', 120, '0xc'), ('ethereum_other_transfers', 999, '0xd')"
    )
    assert read_cursor("ethereum_erc20_transfers") == 180


def test_no_cursor_for_a_source_with_no_rows_while_another_has_some(database):
    database(SYNC + "; insert into raw._sync values ('ethereum_other_transfers', 999, '0xd')")
    assert read_cursor("ethereum_erc20_transfers") is None


def test_legacy_warehouse_has_no_coverage_evidence(database):
    from pipeline.warehouse import read_coverage
    database(SYNC + "; insert into raw._sync values ('ethereum_erc20_transfers', 180, '0xa')")
    assert read_coverage("ethereum_erc20_transfers") == []


def test_coverage_reader_keeps_generation_filters_and_verification(database):
    from pipeline.warehouse import read_coverage
    database("create schema raw; create table raw._coverage (source_table text, from_block bigint, "
             "to_block bigint, config jsonb, verified boolean); "
             "insert into raw._coverage values "
             "('ethereum_erc20_transfers', 100, 180, '{\"filter\":{\"tokens\":[\"a\"]}}', true), "
             "('ethereum_erc20_transfers', 181, 200, '{\"filter\":{\"tokens\":[\"b\"]}}', false), "
             "('another_source', 1, 999, '{}', true)")
    assert read_coverage("ethereum_erc20_transfers") == [
        {"first": 100, "last": 180, "config": {"filter": {"tokens": ["a"]}}, "verified": True},
        {"first": 181, "last": 200, "config": {"filter": {"tokens": ["b"]}}, "verified": False},
    ]


def test_configuration_cursor_selects_its_own_sync_row(database):
    from pipeline.warehouse import read_configuration_cursor
    database(SYNC + "; create table raw._source_configurations (source_table text, cursor_id text, config jsonb); "
             "insert into raw._sync values ('source', 999, 'old'), ('source_new', 125, 'new'); "
             "insert into raw._source_configurations values "
             "('source', 'source', '{\"generation\":1}'), ('source', 'source_new', '{\"generation\":2}')")
    assert read_configuration_cursor("source", {"generation": 2}) == (True, 125)
    assert read_configuration_cursor("source", {"generation": 3}) == (True, None)
    assert read_configuration_cursor("untracked", {}) == (False, None)


def test_oracle_freshness_includes_new_generation_cursors_and_preserves_legacy_behavior(database, scratch):
    from pathlib import Path
    from jinja2 import Environment
    database('create schema raw; create table raw._sync (id text, "current_timestamp" timestamptz); '
             'create table raw.chainlink_feeds (chain text, proxy text, feed text, heartbeat_seconds integer); '
             'create table raw.oracle_prices (chain text, proxy text, updated_at timestamptz); '
             "insert into raw.chainlink_feeds values ('ethereum', 'proxy', 'feed', 3600); "
             "insert into raw.oracle_prices values ('ethereum', 'proxy', '2026-01-01'); "
             "insert into raw._sync values ('ethereum_chainlink_price_feeds', '2026-01-01')")
    query = Environment().from_string((Path(__file__).resolve().parents[2] /
        'transformation/tests/oracle_prices_within_heartbeat.sql').read_text()).render(
            config=lambda **kwargs: '', env_var=lambda *args: 'raw', ref=lambda name: f'raw.{name}')
    with closing(psycopg2.connect(**scratch)) as connection, connection.cursor() as cursor:
        cursor.execute(query)
        assert cursor.fetchall() == []
    database("delete from raw._sync; insert into raw._sync values "
             "('ethereum_chainlink_price_feeds_abcdef012345abcdef012345', '2026-01-02')")
    with closing(psycopg2.connect(**scratch)) as connection, connection.cursor() as cursor:
        cursor.execute(query)
        assert [row[0:3] for row in cursor.fetchall()] == [('ethereum', 'feed', 'proxy')]
