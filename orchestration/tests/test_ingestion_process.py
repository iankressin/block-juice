"""Real subprocesses prove logs drain while ingestion runs, without contacting a provider."""

import logging
import os
import subprocess
import sys
import textwrap
from types import SimpleNamespace

import dagster as dg
import pytest

from pipeline.assets import ingestion


class RecordingLog:
    def __init__(self, on_message=lambda level, message: None):
        self.messages = []
        self.on_message = on_message

    def log(self, level, message):
        self.on_message(level, message)
        self.messages.append((level, message))

    def warning(self, message):
        self.log(logging.WARNING, message)


def run_child(code, folder, log):
    return ingestion.run_ingestion_process(
        [sys.executable, "-u", "-c", textwrap.dedent(code)], cwd=folder,
        env={**os.environ, "ACK": str(folder / "ack")}, log=log,
    )


def test_log_arrives_before_child_can_finish(tmp_path):
    def acknowledge(level, message):
        if message == "Batch written records=3":
            (tmp_path / "ack").touch()

    log = RecordingLog(acknowledge)
    code, errors, stderr = run_child("""
        import json, os, time
        from pathlib import Path
        print(json.dumps({"level": 30, "msg": "Batch written", "records": 3}), flush=True)
        deadline = time.monotonic() + 5
        while not Path(os.environ["ACK"]).exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        raise SystemExit(0 if Path(os.environ["ACK"]).exists() else 8)
    """, tmp_path, log)
    assert code == 0
    assert errors == stderr == ""
    assert log.messages == [(logging.INFO, "Batch written records=3")]


def test_stderr_drains_alongside_stdout_and_is_warned_on_success(tmp_path):
    log = RecordingLog()
    code, errors, stderr = run_child("""
        import sys
        sys.stderr.write("x" * 200000 + "\\nlast warning\\n")
        sys.stderr.flush()
        print('{"level":30,"msg":"finished"}', flush=True)
    """, tmp_path, log)
    assert code == 0
    assert errors == ""
    assert len(stderr) <= 65536
    assert stderr.endswith("last warning\n")
    assert (logging.WARNING, "last warning") in log.messages
    assert (logging.INFO, "finished") in log.messages


def test_failure_keeps_recent_errors_stderr_and_fatal_stack(tmp_path):
    log = RecordingLog()
    code, errors, stderr = run_child("""
        import json, sys
        for i in range(2000):
            print(json.dumps({"level": 50, "msg": "old error " + str(i) + "x" * 50}))
        print(json.dumps({"level": 60, "msg": "Run failed", "err": {"stack": "boom\\n at source"}}))
        print("last stderr", file=sys.stderr)
        raise SystemExit(7)
    """, tmp_path, log)
    assert code == 7
    assert len(errors) <= 65536
    assert "old error 0x" not in errors
    assert errors.endswith("Run failed\nboom\n at source\n")
    assert stderr == "last stderr\n"
    assert (logging.CRITICAL, "Run failed\nboom\n at source") in log.messages


@pytest.mark.parametrize("preceding_error", [False, True])
def test_oversized_fatal_keeps_bounded_raw_diagnostics(tmp_path, preceding_error):
    log = RecordingLog()
    script = """
        import json, sys
        if PRECEDING_ERROR:
            print(json.dumps({"level": 50, "msg": "earlier failure"}))
        print(json.dumps({
            "level": 60, "msg": "fatal failure",
            "err": {"stack": "x" * 200000 + " useful trailing stack marker"},
        }))
        raise SystemExit(9)
    """.replace("PRECEDING_ERROR", str(preceding_error))
    code, errors, stderr = run_child(script, tmp_path, log)
    assert code == 9
    assert stderr == ""
    assert 0 < len(errors) <= 65536
    assert "stdout diagnostic fallback" in errors
    assert "truncated" in errors
    assert "useful trailing stack marker" in errors
    assert max(len(message) for _, message in log.messages) <= 65536


def test_logging_failure_stops_and_reaps_the_child(tmp_path, monkeypatch):
    children = []
    popen = subprocess.Popen

    def capture_child(*args, **kwargs):
        child = popen(*args, **kwargs)
        children.append(child)
        return child

    def fail_log(level, message):
        raise RuntimeError("logger unavailable")

    monkeypatch.setattr(ingestion.subprocess, "Popen", capture_child)
    with pytest.raises(RuntimeError, match="logger unavailable"):
        run_child("""
            import time
            print("ready", flush=True)
            time.sleep(60)
        """, tmp_path, RecordingLog(fail_log))
    assert children[0].poll() is not None


def test_spawn_failure_is_reported(tmp_path):
    with pytest.raises(FileNotFoundError):
        ingestion.run_ingestion_process(
            [str(tmp_path / "missing-executable")], cwd=tmp_path, env={}, log=RecordingLog(),
        )


@pytest.mark.parametrize("exit_code", [0, 7])
def test_asset_preserves_source_context_and_failure_metadata(tmp_path, monkeypatch, exit_code):
    popen = subprocess.Popen
    context = SimpleNamespace(run_id="test-run", log=RecordingLog())
    expected_folder = ingestion.package_dir("ethereum", "eth_balances")

    def launch_fixture(command, **kwargs):
        assert command == ["pnpm", "--silent", "ingest"]
        assert kwargs["cwd"] == expected_folder
        script = """
import json, os, sys
assert os.environ['DAGSTER_RUN_ID'] == 'test-run'
assert os.environ['CHAIN'] == 'ethereum'
print(json.dumps({'level': 50, 'msg': 'source error'}))
print('source warning', file=sys.stderr)
sys.exit(EXIT_CODE)
""".replace("EXIT_CODE", str(exit_code))
        return popen([sys.executable, "-u", "-c", script], **kwargs)

    from contextlib import nullcontext

    monkeypatch.setattr(ingestion, "warehouse_slot", lambda *args: nullcontext())
    monkeypatch.setattr(ingestion.subprocess, "Popen", launch_fixture)
    ingest = ingestion.build_ingestion_asset("ethereum", "eth_balances").op.compute_fn.decorated_fn
    if exit_code:
        with pytest.raises(dg.Failure, match="exited with code 7") as failed:
            ingest(context)
        assert failed.value.metadata["errors"].value.strip() == "source error"
        assert failed.value.metadata["stderr"].value.strip() == "source warning"
    else:
        assert isinstance(ingest(context), dg.MaterializeResult)
    assert (logging.ERROR, "source error") in context.log.messages
    assert (logging.WARNING, "source warning") in context.log.messages
