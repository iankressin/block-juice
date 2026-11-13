"""The optional concurrent index operation repairs interrupted builds and is safe to repeat."""

from pathlib import Path

import psycopg2
from dbt.cli.main import dbtRunner

from test_warehouse import scratch


PROJECT = Path(__file__).resolve().parents[2] / "transformation"


def test_state_index_operation_repairs_invalid_index_and_preserves_live_views(scratch, monkeypatch, tmp_path):
    for name, key in {"HOST": "host", "PORT": "port", "USER": "user", "PASSWORD": "password", "DB": "dbname"}.items():
        monkeypatch.setenv("WAREHOUSE_" + name, str(scratch[key]))
    monkeypatch.setenv("RAW_SCHEMA", "raw")
    monkeypatch.setenv("DBT_SCHEMA", "analytics")
    connection = psycopg2.connect(**scratch)
    connection.autocommit = True
    try:
        with connection.cursor() as cursor:
            cursor.execute("""
                create schema raw;
                create table raw.base_address_code (id text primary key, data jsonb, _loaded_at timestamptz);
                insert into raw.base_address_code values
                    ('1', '{"address":"WALLET","block_number":"invalid","code":"0x"}', now());
                create view raw.live_code as select * from raw.base_address_code;
            """)

            def invoke(family="address_code"):
                return dbtRunner().invoke([
                    "run-operation", "index_state_readings", "--args", "{family: " + family + "}",
                    "--project-dir", str(PROJECT), "--profiles-dir", str(PROJECT),
                    "--target-path", str(tmp_path / "target"), "--log-path", str(tmp_path / "logs"),
                    "--no-send-anonymous-usage-stats", "--quiet",
                ])

            assert not invoke().success
            cursor.execute("select indisvalid from pg_index where indexrelid::regclass::text like '%bj_state_%'")
            assert cursor.fetchall() == [(False,)]
            cursor.execute("update raw.base_address_code set data=jsonb_set(data,'{block_number}','100')")
            assert invoke().success
            cursor.execute("select indexrelid, indisvalid from pg_index where indexrelid::regclass::text like '%bj_state_%'")
            index_oid, valid = cursor.fetchone()
            assert valid
            assert invoke().success
            cursor.execute("select indexrelid from pg_index where indexrelid::regclass::text like '%bj_state_%'")
            assert cursor.fetchone()[0] == index_oid
            cursor.execute("update raw.base_address_code set data=jsonb_set(data,'{code}','\"0x1234\"')")
            cursor.execute("select data->>'code' from raw.live_code")
            assert cursor.fetchone()[0] == "0x1234"
            cursor.execute("""
                create table raw.ethereum_account_state (like raw.base_address_code including all);
                insert into raw.ethereum_account_state values
                    ('1', '{"address":"WALLET","block_number":100,"kind":"code","code":"0x"}', now());
            """)
            assert invoke("account_state").success
            cursor.execute("""
                select indexdef from pg_indexes where schemaname='raw'
                and tablename='ethereum_account_state' and indexname like 'bj_state_%'
            """)
            definition = cursor.fetchone()[0]
            assert all(expression in definition for expression in ("block_number", "kind", "address", "_loaded_at DESC"))
            assert not invoke("unsupported").success
    finally:
        connection.close()
