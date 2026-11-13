"""Warehouse-wide budgets shared by Dagster workers, including separate local instances."""

from contextlib import closing, contextmanager
import os
import time
from typing import Literal

from pipeline.warehouse import connect

Pool = Literal["ingestion", "dbt"]
DEFAULT_LIMITS = {"ingestion": 4, "dbt": 1}


def concurrency_limit(pool: Pool) -> int:
    name = f"BJ_{pool.upper()}_CONCURRENCY"
    value = os.environ.get(name) or str(DEFAULT_LIMITS[pool])
    if not value.isascii() or not value.isdecimal() or not 1 <= int(value) <= 64:
        raise ValueError(f"{name} must be a whole number between 1 and 64")
    return int(value)


@contextmanager
def warehouse_slot(pool: Pool, log=None):
    """Hold one session advisory lock while working; closing the connection releases on failure.

    Budgets are scoped to this warehouse database, including workers on different machines. Every
    worker should use the same configured limit. This connection is never shared with work/data
    transactions, and autocommit avoids retaining a transaction snapshot while a provider runs.
    """
    limit = concurrency_limit(pool)
    with closing(connect()) as connection:
        connection.autocommit = True
        with connection.cursor() as cursor:
            announced = False
            while True:
                for slot in range(1, limit + 1):
                    cursor.execute("select pg_try_advisory_lock(hashtext(%s), %s)",
                                   (f"blockjuice:{pool}", slot))
                    if cursor.fetchone()[0]:
                        # This dedicated session closes on every exit, releasing its lock without
                        # a cleanup query that could hide the work's original error.
                        yield
                        return
                if log is not None and not announced:
                    log.info(f"Waiting for warehouse {pool} capacity ({limit} concurrent jobs)")
                    announced = True
                time.sleep(0.25)
