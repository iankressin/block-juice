import json
import logging
import os
import subprocess
from contextlib import closing

import dagster as dg
from psycopg2 import sql

from pipeline.project import INGESTION_DIR
from pipeline.warehouse import connect

# (source name, table name) pairs. Each must match a package at ingestion/sources/<source>-<table>,
# with underscores in the table name written as hyphens, and a source table in the dbt project;
# dagster-dbt keys dbt sources the same way.
SOURCES = [
    ("ethereum", "eth_balances"),
    ("ethereum", "erc20_balances"),
    ("solana", "sol_balances"),
    ("solana", "spl_balances"),
    ("bitcoin", "btc_balances"),
]


def package_dir(source: str, table: str):
    return INGESTION_DIR / "sources" / f"{source}-{table.replace('_', '-')}"


PINO_LEVELS = {
    10: logging.DEBUG,
    20: logging.DEBUG,
    30: logging.INFO,
    40: logging.WARNING,
    50: logging.ERROR,
    60: logging.CRITICAL,
}
# Fields on every line, fields the asset key already shows, and the error, which gets its own line.
PINO_HIDDEN_FIELDS = {"level", "time", "pid", "hostname", "msg", "source", "table", "err"}


def parse_log_line(line: str) -> tuple[int, str]:
    """A pino JSON line becomes its logging level and a message. Any other line logs as info."""
    try:
        entry = json.loads(line)
    except json.JSONDecodeError:
        return logging.INFO, line
    if not isinstance(entry, dict) or entry.get("level") not in PINO_LEVELS:
        return logging.INFO, line
    fields = " ".join(
        f"{key}={json.dumps(value)}" for key, value in entry.items() if key not in PINO_HIDDEN_FIELDS
    )
    message = " ".join(part for part in (entry.get("msg", ""), fields) if part)
    err = entry.get("err")
    if isinstance(err, dict):
        message += "\n" + err.get("stack", err.get("message", ""))
    return PINO_LEVELS[entry["level"]], message


def build_ingestion_asset(source: str, table: str) -> dg.AssetsDefinition:
    @dg.asset(
        key=[source, table],
        group_name="ingestion",
        kinds={"typescript", "postgres"},
    )
    def _ingest(context: dg.AssetExecutionContext) -> dg.MaterializeResult:
        result = subprocess.run(
            ["pnpm", "--silent", "ingest"],
            cwd=package_dir(source, table),
            # The source writes the run id into ops.ingestion_runs, next to the dbt results of the same run.
            env={**os.environ, "DAGSTER_RUN_ID": context.run_id},
            capture_output=True,
            text=True,
        )
        errors = []
        for line in result.stdout.splitlines():
            if not line.strip():
                continue
            level, message = parse_log_line(line)
            context.log.log(level, message)
            if level >= logging.ERROR:
                errors.append(message)
        if result.stderr and result.returncode == 0:
            context.log.warning(result.stderr)
        if result.returncode != 0:
            raise dg.Failure(
                description=f"Ingestion for {source} exited with code {result.returncode}",
                metadata={
                    "errors": dg.MetadataValue.text("\n".join(errors)),
                    "stderr": dg.MetadataValue.text(result.stderr),
                },
            )
        return dg.MaterializeResult()

    return _ingest


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


def build_dead_letter_check(source: str, table: str) -> dg.AssetChecksDefinition:
    @dg.asset_check(
        asset=dg.AssetKey([source, table]),
        name="no_dead_letters",
        description="Calls that failed and wait in the raw schema's _dead_letters table. Warns, never blocks.",
    )
    def _check() -> dg.AssetCheckResult:
        pending, parked = count_dead_letters(f"{source}_{table}")
        return dg.AssetCheckResult(
            passed=pending + parked == 0,
            severity=dg.AssetCheckSeverity.WARN,
            metadata={"pending": pending, "parked": parked},
        )

    return _check


ingestion_assets = [build_ingestion_asset(source, table) for source, table in SOURCES]
ingestion_checks = [build_dead_letter_check(source, table) for source, table in SOURCES]
