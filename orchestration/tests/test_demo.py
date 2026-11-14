import subprocess
from pathlib import Path

import pytest

from pipeline import cli, demo
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


def test_demo_cli_ignores_checkout_environment(tmp_path, monkeypatch):
    home = tmp_path / "regular-file"
    home.touch()
    monkeypatch.setenv("DAGSTER_HOME", str(home))
    monkeypatch.setattr(cli, "load_dotenv", lambda *a, **kw: pytest.fail("read checkout .env"))
    monkeypatch.setattr(demo, "run", lambda root, output: 0)
    assert cli.main(["demo"]) == 0


def test_interrupted_demo_export_can_retry_same_destination(tmp_path, monkeypatch):
    output = tmp_path / "export"
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/docker")
    interrupt = True

    def command(args, **kwargs):
        if "port" in args:
            return subprocess.CompletedProcess(args, 0, "127.0.0.1:54321\n", "")
        if "pipeline.demo" in args:
            export = Path(args[-1])
            export.mkdir()
            (export / "answer.json").write_text("{}")
            if interrupt:
                raise subprocess.TimeoutExpired(args, 300)
            (export / "answer.md").write_text("3.75 ETH")
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(subprocess, "run", command)
    with pytest.raises(BadInput, match="demo failed"):
        run(tmp_path, output)
    assert list(tmp_path.iterdir()) == []
    interrupt = False
    assert run(tmp_path, output) == 0
    assert sorted(p.name for p in output.iterdir()) == ["answer.json", "answer.md"]


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
