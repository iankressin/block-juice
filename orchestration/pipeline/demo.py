"""A bounded, isolated raw -> dbt -> answer -> report example using synthetic balance readings."""

import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import uuid
from contextlib import closing
from dataclasses import astuple
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.cli import BadInput

TABLES = (
    "ethereum_eth_balances", "ethereum_erc20_balances", "solana_sol_balances",
    "solana_spl_balances", "bitcoin_btc_balances",
    "ethereum_erc20_transfers", "arbitrum_erc20_transfers", "base_erc20_transfers",
)


def demo_environment(base: dict, folder: Path, *, port: str, password: str, pythonpath: str) -> dict:
    # The worker needs only OS runtime settings. In particular, do not inherit warehouse,
    # source, dbt, libpq or provider overrides from the caller's real setup.
    runtime_keys = {
        "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "LANG",
        "LC_ALL", "LC_CTYPE", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
    }
    env = {name: value for name, value in base.items() if name in runtime_keys}
    env.update(
        WAREHOUSE_HOST="127.0.0.1", WAREHOUSE_PORT=port, WAREHOUSE_USER="demo",
        WAREHOUSE_PASSWORD=password, WAREHOUSE_DB="demo", RAW_SCHEMA="raw", DBT_SCHEMA="analytics",
        DAGSTER_HOME=str(folder / "dagster"), PYTHONPATH=pythonpath,
        DBT_SEND_ANONYMOUS_USAGE_STATS="false", DBT_PARTIAL_PARSE="false",
        PGCONNECT_TIMEOUT="5",
    )
    return env


def run(repo_root: Path, output: Path | None = None) -> int:
    output = Path(output) if output else repo_root / ".demo" / uuid.uuid4().hex[:12]
    output = output.absolute()
    if os.path.lexists(output):
        raise BadInput(f"demo output already exists: {output}; choose a new directory")
    if shutil.which("docker") is None:
        raise BadInput("the demo needs Docker; install it and start its daemon")
    name = "block-juice-demo-" + uuid.uuid4().hex[:12]
    password = secrets.token_hex(16)
    try:
        with TemporaryDirectory(prefix="block-juice-demo-") as temporary:
            folder = Path(temporary)
            subprocess.run(
                ["docker", "run", "--detach", "--rm", "--name", name,
                 "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=demo",
                 "--env", f"POSTGRES_PASSWORD={password}", "--env", "POSTGRES_DB=demo", "postgres:16"],
                check=True, capture_output=True, text=True, timeout=180,
            )
            ports = subprocess.run(
                ["docker", "port", name, "5432/tcp"], check=True,
                capture_output=True, text=True, timeout=15,
            ).stdout.strip()
            if not ports.startswith("127.0.0.1:") or not ports.split(":")[-1].isdigit():
                raise BadInput(f"Docker returned an unexpected demo port binding: {ports}")
            env = demo_environment(
                os.environ, folder, port=ports.split(":")[-1], password=password,
                pythonpath=str(repo_root / "orchestration"),
            )
            subprocess.run(
                [sys.executable, "-m", "pipeline.demo", str(repo_root), str(folder), str(output)],
                env=env, check=True, timeout=300,
            )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as error:
        detail = getattr(error, "stderr", None) or str(error)
        raise BadInput(f"demo failed: {' '.join(str(detail).split())}") from None
    finally:
        # Only this invocation's random name is removed, including a failed startup or worker.
        try:
            cleaned = subprocess.run(["docker", "rm", "--force", name],
                                     capture_output=True, text=True, check=False, timeout=30)
            if cleaned.returncode and "No such container" not in cleaned.stderr:
                print(f"Could not remove demo container {name}: {cleaned.stderr.strip()}", file=sys.stderr)
        except (subprocess.TimeoutExpired, OSError) as error:
            print(f"Could not remove demo container {name}: {error}", file=sys.stderr)
    print(f"Synthetic demo passed: 3.75 ETH. Results and XLSX: {output}")
    return 0


def wait_for_postgres() -> None:
    import psycopg2
    from pipeline.warehouse import connect

    deadline = time.monotonic() + 45
    while True:
        try:
            with closing(connect()):
                return
        except psycopg2.OperationalError:
            if time.monotonic() >= deadline:
                raise BadInput("demo Postgres did not become ready within 45 seconds") from None
            time.sleep(0.25)


def load_fixture(repo_root: Path) -> None:
    from psycopg2 import sql
    from psycopg2.extras import Json
    from pipeline.warehouse import connect

    readings = json.loads((repo_root / "examples/balances/readings.json").read_text())
    with closing(connect()) as connection, connection, connection.cursor() as cursor:
        cursor.execute((repo_root / "infra/postgres/ops.sql").read_text())
        cursor.execute("create schema raw")
        for table in TABLES:
            cursor.execute(sql.SQL(
                "create table raw.{} (id text primary key, data jsonb not null,"
                " _loaded_at timestamptz not null default now())"
            ).format(sql.Identifier(table)))
        for reading in readings:
            if reading["table"] not in TABLES:
                raise BadInput(f"unknown demo fixture table {reading['table']}")
            cursor.execute(sql.SQL("insert into raw.{} (id, data) values (%s, %s)").format(
                sql.Identifier(reading["table"])
            ), (reading["id"], Json(reading["data"])))
        for table in TABLES:
            source, name = table.split("_", 1)
            cursor.execute(
                "insert into ops.ingestion_runs (run_id, dagster_run_id, source, table_name,"
                " started_at, finished_at, succeeded, records_written, failed_calls, retried_calls,"
                " load_seconds, dead_letters_pending, dead_letters_parked)"
                " values (%s, 'synthetic-demo', %s, %s, now(), now(), true, %s, 0, 0, 0, 0, 0)",
                (str(uuid.uuid4()), source, name, sum(r["table"] == table for r in readings)),
            )


def record_build(result: dict, started_at: datetime) -> None:
    from psycopg2.extras import execute_values
    from pipeline.run_log import dbt_run_rows
    from pipeline.warehouse import connect

    invocation, nodes = dbt_run_rows(
        result, dagster_run_id="synthetic-demo", command="build", started_at=started_at,
        finished_at=datetime.now(timezone.utc), error=None,
    )
    with closing(connect()) as connection, connection, connection.cursor() as cursor:
        cursor.execute(
            "insert into ops.dbt_invocations (invocation_id, dagster_run_id, command, started_at,"
            " finished_at, succeeded, dbt_version, error) values (%s,%s,%s,%s,%s,%s,%s,%s)",
            astuple(invocation),
        )
        execute_values(cursor,
            "insert into ops.dbt_node_runs (invocation_id, unique_id, resource_type, name, status,"
            " started_at, finished_at, execution_seconds, rows_affected, failures, message) values %s",
            [astuple(node) for node in nodes],
        )


def worker(repo_root: Path, folder: Path, output: Path) -> None:
    from pipeline.cli import answer, report

    Path(os.environ["DAGSTER_HOME"]).mkdir()
    (Path(os.environ["DAGSTER_HOME"]) / "dagster.yaml").write_text("{}\n")
    shutil.copytree(repo_root / "transformation", folder / "transformation",
                    ignore=shutil.ignore_patterns("target", "logs", "dbt_packages", ".user.yml"))
    # These balance analyses read only call-source tables. Their registry is sufficient for
    # lineage; real source filters, credentials and extraction configuration are not needed.
    (folder / "ingestion").mkdir()
    shutil.copy2(repo_root / "ingestion/sources.json", folder / "ingestion/sources.json")
    slug = "tracked-wallets-eth"
    destination = folder / "answers" / slug
    destination.mkdir(parents=True)
    shutil.copy2(repo_root / "answers" / slug / "question.yaml", destination / "question.yaml")
    wait_for_postgres()
    load_fixture(repo_root)
    project = folder / "transformation"
    started = datetime.now(timezone.utc)
    # Balance reconciliation tests also reference the transfer mart. Build its empty fixture
    # dependencies, so the ordinary checks can run without fake relations or skipped tests.
    result = answer.dbt(project, "build", "--select", "+latest_balances", "+erc20_transfers",
                        "--exclude", "tag:reference", "--target-path", str(project / "target"))
    if not result.success:
        raise BadInput(f"demo dbt build failed: {answer.dbt_error(result)}")
    record_build(json.loads((project / "target/run_results.json").read_text()), started)
    if answer.run(folder, slug) != 0:
        raise BadInput("demo answer checks failed")
    document = json.loads((destination / "answer.json").read_text())
    if Decimal(str(document["value"])) != Decimal("3.75"):
        raise BadInput(f"demo expected 3.75 ETH, got {document['value']}")
    (destination / "answer.md").write_text(
        "# Synthetic balance example\n\nThe two synthetic Ethereum wallets hold **3.75 ETH** "
        "at block 100: 1.25 ETH and 2.5 ETH. The older 1 ETH reading at block 99 is superseded. "
        "ERC-20, SOL and BTC rows do not contribute to the ETH total.\n\n"
        "These are local fixture rows, not on-chain observations. The ordinary dbt models, "
        "tests and answer checks ran against this isolated fixture warehouse.\n"
    )
    if report.run(folder, slug, "xlsx") != 0:
        raise BadInput("demo report export failed")
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(destination, output, symlinks=True)


if __name__ == "__main__":
    try:
        worker(*(Path(argument) for argument in sys.argv[1:]))
    except BadInput as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
