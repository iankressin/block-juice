import os
from contextlib import closing
from dataclasses import dataclass

import psycopg2
from psycopg2 import sql


def connect():
    """A connection to the warehouse, from the WAREHOUSE_* settings that dbt and ingestion also read."""
    return psycopg2.connect(
        host=os.environ["WAREHOUSE_HOST"],
        port=os.environ["WAREHOUSE_PORT"],
        user=os.environ["WAREHOUSE_USER"],
        password=os.environ["WAREHOUSE_PASSWORD"],
        dbname=os.environ["WAREHOUSE_DB"],
    )


def count_dead_letters(source_table: str) -> tuple[int, int]:
    """(pending, parked) dead letters for one raw table. Ingestion creates the table on first run."""
    schema = os.environ["RAW_SCHEMA"]
    with closing(connect()) as connection, connection.cursor() as cursor:
        cursor.execute("select to_regclass(%s)", (f'"{schema}"._dead_letters',))
        if cursor.fetchone()[0] is None:
            return 0, 0
        cursor.execute(
            sql.SQL(
                "select count(*) filter (where not parked), count(*) filter (where parked)"
                " from {}._dead_letters where source_table = %s"
            ).format(sql.Identifier(schema)),
            (source_table,),
        )
        pending, parked = cursor.fetchone()
        return pending, parked


@dataclass(frozen=True)
class Cursor:
    """The last block a stream source loaded, by number and hash, as Pipes saved it."""

    number: int
    hash: str


def read_cursor(source_table: str) -> Cursor | None:
    """The highest block Pipes saved for a stream source in the raw schema's _sync table, which Pipes
    creates on the first run. None before then. Pipes keys the table by id and block number, so the
    highest block has one row, and Pipes resumes from it."""
    schema = os.environ["RAW_SCHEMA"]
    with closing(connect()) as connection, connection.cursor() as cursor:
        cursor.execute("select to_regclass(%s)", (f'"{schema}"._sync',))
        if cursor.fetchone()[0] is None:
            return None
        cursor.execute(
            sql.SQL(
                "select current_number, current_hash from {}._sync where id = %s order by current_number desc limit 1"
            ).format(sql.Identifier(schema)),
            (source_table,),
        )
        row = cursor.fetchone()
        return Cursor(int(row[0]), row[1]) if row else None
