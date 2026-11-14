"""Warehouse-wide budgets shared by Dagster workers, including separate local instances."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from functools import partial
import os
import random
from threading import Event
import time
from typing import Literal

import psycopg2

from pipeline.warehouse import connect

Pool = Literal["ingestion", "dbt"]
DEFAULT_LIMITS = {"ingestion": 4, "dbt": 1}


def concurrency_limit(pool: Pool) -> int:
    name = f"BJ_{pool.upper()}_CONCURRENCY"
    value = os.environ.get(name) or str(DEFAULT_LIMITS[pool])
    if not value.isascii() or not value.isdecimal() or not 1 <= int(value) <= 64:
        raise ValueError(f"{name} must be a whole number between 1 and 64")
    return int(value)


def connect_for_slot():
    try:
        return connect(keepalives=1, keepalives_idle=10, keepalives_interval=2, keepalives_count=3)
    except psycopg2.OperationalError as error:
        # libpq can omit SQLSTATE for a FATAL error during connection startup.
        if error.pgcode == "53300" or any(message in str(error) for message in (
            "too many clients", "remaining connection slots", "too many connections",
        )):
            return None
        raise


@contextmanager
def monitor_slot(connection, pool, cancel):
    """Check the dedicated session even while a child is silent or its output pipe is blocked."""
    stopped = Event()

    def check_ownership():
        try:
            with connection.cursor() as cursor:
                while True:
                    # This session acquires exactly one lock and never reconnects.
                    cursor.execute(
                        "select exists (select from pg_locks where pid = pg_backend_pid()"
                        " and locktype = 'advisory' and granted)"
                    )
                    if not cursor.fetchone()[0]:
                        raise RuntimeError("advisory lock was released")
                    if stopped.wait(1):
                        return
        except Exception as error:
            cancel()
            raise RuntimeError(f"lost warehouse {pool} slot") from error

    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="warehouse-slot") as executor:
        monitor = executor.submit(check_ownership)
        try:
            yield
        finally:
            stopped.set()
            monitor.result()


@contextmanager
def warehouse_slot(pool: Pool, log=None):
    """Hold a session advisory lock and supply the subprocess monitor for its owner."""
    limit = concurrency_limit(pool)
    delay = 0.25
    announced = False
    while True:
        connection = connect_for_slot()
        if connection is not None:
            with closing(connection):
                connection.autocommit = True
                with connection.cursor() as cursor:
                    for slot in range(1, limit + 1):
                        cursor.execute(
                            "select pg_try_advisory_lock(hashtext(%s), %s)",
                            (f"blockjuice:{pool}", slot),
                        )
                        if cursor.fetchone()[0]:
                            yield partial(monitor_slot, connection, pool)
                            return
        if log is not None and not announced:
            log.info(f"Waiting for warehouse {pool} capacity ({limit} concurrent jobs)")
            announced = True
        time.sleep(random.uniform(delay / 2, delay))
        delay = min(delay * 2, 5)
