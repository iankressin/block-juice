import subprocess

import pytest

from pipeline.cli import BadInput
from pipeline.demo import demo_environment, run


def test_demo_overrides_every_warehouse_target_and_isolates_history(tmp_path):
    env = demo_environment(
        {"WAREHOUSE_HOST": "production", "WAREHOUSE_DB": "important", "RAW_SCHEMA": "real",
         "DAGSTER_HOME": "/real/history", "DBT_SCHEMA": "real", "PGOPTIONS": "--role=admin"},
        tmp_path, port="54321", password="synthetic", pythonpath="/checkout/orchestration",
    )
    assert env["WAREHOUSE_HOST"] == "127.0.0.1"
    assert env["WAREHOUSE_PORT"] == "54321"
    assert env["WAREHOUSE_DB"] == "demo"
    assert env["RAW_SCHEMA"] == "raw"
    assert env["DBT_SCHEMA"] == "analytics"
    assert env["DAGSTER_HOME"] == str(tmp_path / "dagster")
    assert "PGOPTIONS" not in env


def test_demo_does_not_inherit_source_or_dbt_overrides(tmp_path):
    env = demo_environment(
        {"START_BLOCK": "999999999", "MAX_BLOCKS_PER_RUN": "bad", "DBT_TARGET": "prod",
         "DBT_PROFILES_DIR": "/production/profiles", "DBT_VARS": "unsafe", "RPC_URL": "secret",
         "PATH": "/usr/bin"},
        tmp_path, port="54321", password="synthetic", pythonpath="/checkout/orchestration",
    )
    assert env["PATH"] == "/usr/bin"
    assert not {"START_BLOCK", "MAX_BLOCKS_PER_RUN", "DBT_TARGET", "DBT_PROFILES_DIR",
                "DBT_VARS", "RPC_URL"} & env.keys()


def test_existing_output_is_rejected_before_starting_docker(tmp_path, monkeypatch):
    out = tmp_path / "already-here"
    out.mkdir()
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("must not start Docker"))
    with pytest.raises(BadInput, match="already exists"):
        run(tmp_path, out)


def test_failed_worker_removes_only_its_container(tmp_path, monkeypatch):
    commands = []
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/docker")

    def command(args, **kwargs):
        commands.append(args)
        if "port" in args:
            return subprocess.CompletedProcess(args, 0, "127.0.0.1:54321\n", "")
        if "pipeline.demo" in args:
            raise subprocess.CalledProcessError(1, args)
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(subprocess, "run", command)
    with pytest.raises(BadInput, match="demo failed"):
        run(tmp_path, tmp_path / "output")
    started = next(args for args in commands if args[:2] == ["docker", "run"])
    name = started[started.index("--name") + 1]
    assert name.startswith("block-juice-demo-")
    assert commands[-1] == ["docker", "rm", "--force", name]
    assert "--publish" in started and "127.0.0.1::5432" in started
    assert not (tmp_path / "output").exists()


def test_cleanup_error_preserves_original_failure(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/docker")

    def command(args, **kwargs):
        if args[:2] == ["docker", "rm"]:
            raise subprocess.TimeoutExpired(args, 30)
        raise subprocess.CalledProcessError(1, args, stderr="original startup failure")

    monkeypatch.setattr(subprocess, "run", command)
    with pytest.raises(BadInput, match="original startup failure"):
        run(tmp_path, tmp_path / "output")
    assert "Could not remove demo container" in capsys.readouterr().err
