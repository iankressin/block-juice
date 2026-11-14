import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from threading import Barrier, Lock
import time

import psycopg2
import pytest

from pipeline import concurrency, warehouse
from pipeline.concurrency import concurrency_limit, warehouse_slot


@pytest.mark.parametrize("value", ["0", "-1", "1.5", "banana", "65"])
def test_invalid_concurrency_is_rejected(monkeypatch, value):
    monkeypatch.setenv("BJ_INGESTION_CONCURRENCY", value)
    with pytest.raises(ValueError, match="BJ_INGESTION_CONCURRENCY"):
        concurrency_limit("ingestion")


def test_empty_concurrency_uses_default(monkeypatch):
    monkeypatch.setenv("BJ_INGESTION_CONCURRENCY", "")
    assert concurrency_limit("ingestion") == 4


requires_warehouse = pytest.mark.skipif(
    not os.environ.get("WAREHOUSE_HOST"), reason="requires PostgreSQL WAREHOUSE_* settings"
)


@requires_warehouse
def test_database_slots_bound_concurrent_work(monkeypatch):
    monkeypatch.setenv("BJ_INGESTION_CONCURRENCY", "2")
    ready = Barrier(3)
    lock = Lock()
    active = maximum = 0

    def worker():
        nonlocal active, maximum
        ready.wait(timeout=10)
        with warehouse_slot("ingestion"):
            with lock:
                active += 1
                maximum = max(maximum, active)
            try:
                time.sleep(0.15)
            finally:
                with lock:
                    active -= 1

    with ThreadPoolExecutor(max_workers=3) as pool:
        workers = [pool.submit(worker) for _ in range(3)]
        for result in workers:
            result.result(timeout=10)
    assert maximum == 2


@requires_warehouse
def test_failed_worker_releases_its_only_slot(monkeypatch):
    monkeypatch.setenv("BJ_INGESTION_CONCURRENCY", "1")
    with pytest.raises(RuntimeError, match="work failed"):
        with warehouse_slot("ingestion"):
            raise RuntimeError("work failed")
    with closing(warehouse.connect()) as connection, connection.cursor() as cursor:
        cursor.execute("select pg_try_advisory_lock(hashtext('blockjuice:ingestion'), 1)")
        assert cursor.fetchone() == (True,)


@requires_warehouse
def test_waiter_disconnects_before_retrying_a_full_pool(monkeypatch):
    monkeypatch.setenv("BJ_DBT_CONCURRENCY", "1")
    attempts = []

    def track_connection(**kwargs):
        connection = warehouse.connect(**kwargs)
        attempts.append(connection)
        return connection

    with closing(warehouse.connect()) as holder, holder.cursor() as cursor:
        cursor.execute("select pg_advisory_lock(hashtext('blockjuice:dbt'), 1)")

        def free_capacity(delay):
            assert delay > 0
            assert attempts[-1].closed
            cursor.execute("select pg_advisory_unlock_all()")

        monkeypatch.setattr(concurrency, "connect", track_connection)
        monkeypatch.setattr(concurrency.time, "sleep", free_capacity)
        with warehouse_slot("dbt"):
            assert len(attempts) == 2
            assert not attempts[-1].closed


@requires_warehouse
def test_retries_connection_exhaustion_before_starting_work(monkeypatch):
    sleeps = []

    def connect_when_available(**kwargs):
        if not sleeps:
            raise psycopg2.OperationalError("FATAL: sorry, too many clients already")
        return warehouse.connect(**kwargs)

    monkeypatch.setattr(concurrency, "connect", connect_when_available)
    monkeypatch.setattr(concurrency.time, "sleep", sleeps.append)
    with warehouse_slot("dbt"):
        assert len(sleeps) == 1 and sleeps[0] > 0


@pytest.mark.parametrize("pool", ["dbt", "ingestion"])
@requires_warehouse
def test_losing_the_slot_stops_a_quiet_child(monkeypatch, tmp_path, pool):
    import logging
    import subprocess
    import sys
    from types import SimpleNamespace

    from pipeline.assets import dbt, ingestion

    session_pids = []
    children = []
    ready = tmp_path / "ready"
    completed = tmp_path / "completed"
    script = (
        "import pathlib, sys, time; pathlib.Path(sys.argv[1]).touch();"
        "time.sleep(6); pathlib.Path(sys.argv[2]).touch()"
    )
    popen = subprocess.Popen

    def track_session(**kwargs):
        connection = warehouse.connect(**kwargs)
        session_pids.append(connection.get_backend_pid())
        return connection

    def start_child(*_, **kwargs):
        child = popen([sys.executable, "-c", script, str(ready), str(completed)], **kwargs)
        children.append(child)
        return child

    def disconnect_running_child():
        deadline = time.monotonic() + 5
        while not ready.exists():
            assert time.monotonic() < deadline, "child failed to start"
            time.sleep(0.02)
        # Drop the session during the stream, after the initial ownership check.
        time.sleep(0.5)
        with closing(warehouse.connect()) as admin, admin.cursor() as cursor:
            cursor.execute("select pg_terminate_backend(%s)", (session_pids[-1],))
            assert cursor.fetchone() == (True,)

    class DbtResource:
        def cli(self, *args, **kwargs):
            process = start_child()

            def stream():
                process.wait()
                yield from ()

            return SimpleNamespace(process=process, stream=stream, get_error=lambda: None)

    context = SimpleNamespace(run_id="test", log=logging.getLogger(__name__))
    monkeypatch.setattr(concurrency, "connect", track_session)
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            terminated = executor.submit(disconnect_running_child)
            with pytest.raises(RuntimeError, match="lost.*warehouse.*slot"):
                if pool == "ingestion":
                    monkeypatch.setattr(ingestion.subprocess, "Popen", start_child)
                    asset = ingestion.build_ingestion_asset("ethereum", "eth_balances")
                    asset.op.compute_fn.decorated_fn(context)
                else:
                    monkeypatch.setattr(dbt, "record_dbt_build", lambda *args: None)
                    list(dbt.transformation_assets.op.compute_fn.decorated_fn(context, DbtResource()))
            terminated.result(timeout=5)
        assert children[0].poll() is not None
        assert not completed.exists()
    finally:
        for child in children:
            child.kill()
            child.wait()
