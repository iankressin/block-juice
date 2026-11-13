from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Lock
import time

import pytest

from pipeline.concurrency import concurrency_limit, warehouse_slot


@pytest.mark.parametrize("value", ["0", "-1", "1.5", "banana", "65"])
def test_invalid_concurrency_is_rejected(monkeypatch, value):
    monkeypatch.setenv("BJ_INGESTION_CONCURRENCY", value)
    with pytest.raises(ValueError, match="BJ_INGESTION_CONCURRENCY"):
        concurrency_limit("ingestion")


def test_empty_concurrency_uses_default(monkeypatch):
    monkeypatch.setenv("BJ_INGESTION_CONCURRENCY", "")
    assert concurrency_limit("ingestion") == 4


def test_database_slots_bound_concurrent_work_and_release_after_failure(monkeypatch):
    import os
    if not os.environ.get("WAREHOUSE_HOST"):
        pytest.skip("requires PostgreSQL WAREHOUSE_* settings")
    monkeypatch.setenv("BJ_INGESTION_CONCURRENCY", "2")
    ready = Barrier(3)
    lock = Lock()
    active = maximum = 0

    def worker(fail=False):
        nonlocal active, maximum
        ready.wait(timeout=10)
        with warehouse_slot("ingestion"):
            with lock:
                active += 1
                maximum = max(maximum, active)
            try:
                time.sleep(0.15)
                if fail:
                    raise RuntimeError("work failed")
            finally:
                with lock:
                    active -= 1

    with ThreadPoolExecutor(max_workers=3) as pool:
        failed = pool.submit(worker, True)
        others = [pool.submit(worker) for _ in range(2)]
        with pytest.raises(RuntimeError, match="work failed"):
            failed.result(timeout=10)
        for result in others:
            result.result(timeout=10)
    assert maximum == 2
    # A different connection can reuse a slot even after an exception in the body.
    with warehouse_slot("ingestion"):
        pass
