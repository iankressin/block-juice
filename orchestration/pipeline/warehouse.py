import os
import json
from contextlib import closing

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


def read_cursor(source_table: str) -> int | None:
    """The last block a stream source loaded: the highest block Pipes saved for it in the raw schema's
    _sync table, which Pipes creates on the first run. None before then."""
    schema = os.environ["RAW_SCHEMA"]
    with closing(connect()) as connection, connection.cursor() as cursor:
        cursor.execute("select to_regclass(%s)", (f'"{schema}"._sync',))
        if cursor.fetchone()[0] is None:
            return None
        cursor.execute(
            sql.SQL("select max(current_number) from {}._sync where id = %s").format(sql.Identifier(schema)),
            (source_table,),
        )
        block = cursor.fetchone()[0]
        return int(block) if block is not None else None


def read_coverage(source_table: str) -> list[dict]:
    """Committed ingestion contracts. An absent table means legacy history is unverified."""
    schema = os.environ["RAW_SCHEMA"]
    with closing(connect()) as connection, connection.cursor() as cursor:
        cursor.execute("select to_regclass(%s)", (f'"{schema}"._coverage',))
        if cursor.fetchone()[0] is None:
            return []
        cursor.execute(sql.SQL(
            "select from_block, to_block, config, verified from {}._coverage "
            "where source_table = %s order by from_block, to_block"
        ).format(sql.Identifier(schema)), (source_table,))
        return [dict(first=int(first), last=int(last), config=config, verified=verified)
                for first, last, config, verified in cursor.fetchall()]


def read_configuration_cursor(source_table: str, config: dict) -> tuple[bool, int | None]:
    """Whether this source is tracked, and the cursor of this exact effective configuration."""
    schema = os.environ["RAW_SCHEMA"]
    with closing(connect()) as connection, connection.cursor() as cursor:
        cursor.execute("select to_regclass(%s)", (f'"{schema}"._source_configurations',))
        if cursor.fetchone()[0] is None:
            return False, None
        cursor.execute(sql.SQL(
            "select cursor_id, config = %s::jsonb from {}._source_configurations where source_table = %s"
        ).format(sql.Identifier(schema)), (json.dumps(config), source_table))
        rows = cursor.fetchall()
        if not rows:
            return False, None
        matching = [cursor_id for cursor_id, matches in rows if matches]
        if not matching:
            return True, None
        cursor.execute("select to_regclass(%s)", (f'"{schema}"._sync',))
        if cursor.fetchone()[0] is None:
            return True, None
        cursor.execute(sql.SQL("select max(current_number) from {}._sync where id = %s")
                       .format(sql.Identifier(schema)), (matching[0],))
        block = cursor.fetchone()[0]
        return True, int(block) if block is not None else None
