"""Measure unchanged JSON upserts in an isolated disposable PostgreSQL database.

Uses WAREHOUSE_HOST/PORT/USER/PASSWORD, never WAREHOUSE_DB. Requires CREATEDB and CHECKPOINT privileges.
Run with the orchestration Python environment. The scratch database is dropped in finally.
"""
import json
import os
import uuid

import psycopg2
from psycopg2 import sql


def main():
    settings = {key: os.environ[f"WAREHOUSE_{name}"] for key, name in
                [("host", "HOST"), ("port", "PORT"), ("user", "USER"), ("password", "PASSWORD")]}
    database = "bj_upsert_bench_" + uuid.uuid4().hex[:12]
    admin = psycopg2.connect(dbname="postgres", **settings)
    admin.autocommit = True
    connection = None
    try:
        with admin.cursor() as cursor:
            cursor.execute(sql.SQL("create database {}").format(sql.Identifier(database)))
        connection = psycopg2.connect(dbname=database, **settings)
        connection.autocommit = True
        with connection.cursor() as cursor:
            cursor.execute("""create table input as select i::text id,
                jsonb_build_object('payload', (select string_agg(md5(i::text || ':' || j::text), '')
                from generate_series(1,512) j)) data from generate_series(1,1000) i""")
            for variant in ["original", "reuse"]:
                cursor.execute(sql.SQL("create table {} (id text primary key, data jsonb not null, "
                    "_loaded_at timestamptz not null default now())").format(sql.Identifier(variant)))
                cursor.execute(sql.SQL("insert into {} (id,data) select * from input").format(sql.Identifier(variant)))
            results = []
            for trial in range(3):
                for variant in ["original", "reuse"]:
                    expression = "excluded.data" if variant == "original" else (
                        "case when t.data is distinct from excluded.data then excluded.data else t.data end")
                    cursor.execute("checkpoint")
                    cursor.execute(sql.SQL("explain (analyze, buffers, wal, format json) insert into {} as t "
                        "(id,data) select * from input on conflict(id) do update set data={}, _loaded_at=now()")
                        .format(sql.Identifier(variant), sql.SQL(expression)))
                    plan = cursor.fetchone()[0][0]
                    results.append({"trial": trial, "variant": variant, "rows": 1000,
                        "execution_ms": plan["Execution Time"], "wal_bytes": plan["Plan"].get("WAL Bytes")})
            print(json.dumps(results, indent=2))
    finally:
        if connection:
            connection.close()
        with admin.cursor() as cursor:
            cursor.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(database)))
        admin.close()


if __name__ == "__main__":
    main()
