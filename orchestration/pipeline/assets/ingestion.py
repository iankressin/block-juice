import json
import logging
import os
import signal
import subprocess
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from pathlib import Path
from typing import TextIO

import dagster as dg

from pipeline.project import INGESTION_DIR, REPO_ROOT
from pipeline.sources import SOURCES_FILE, read_sources
from pipeline.warehouse import count_dead_letters

# (source name, table name) pairs, from ingestion/sources.json: the `name` and `table` each package
# exports, which `pnpm generate-sources` writes there. Each must match a source table in the dbt
# project; dagster-dbt keys dbt sources the same way.
ENTRIES = read_sources((REPO_ROOT / SOURCES_FILE).read_text())
SOURCES = [(entry.name, entry.table) for entry in ENTRIES]
PACKAGES = {(entry.name, entry.table): entry.package for entry in ENTRIES}


def package_dir(source: str, table: str):
    return INGESTION_DIR / "sources" / PACKAGES[(source, table)]


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


# Cap each read and failure tail. Very long lines are logged in chunks instead of retained whole.
LOG_CHARS_MAX = 64 * 1024


def read_process_log(pipe: TextIO, log, *, stderr: bool) -> str:
    """Drain one pipe into the thread-safe logger, keeping only its recent failure diagnostics."""
    tail = ""
    raw_tail = ""
    oversized = False
    with pipe:
        while text := pipe.readline(LOG_CHARS_MAX):
            line = text.rstrip("\r\n")
            if stderr:
                tail = (tail + text)[-LOG_CHARS_MAX:]
                if line.strip():
                    log.warning(line)
            elif line.strip():
                raw_tail = (raw_tail + text)[-LOG_CHARS_MAX:]
                oversized |= len(text) == LOG_CHARS_MAX and not text.endswith("\n")
                level, message = parse_log_line(line)
                log.log(level, message)
                if level >= logging.ERROR:
                    tail = (tail + message + "\n")[-LOG_CHARS_MAX:]
    if oversized:
        # A partial JSON line has no reliable Pino severity. Keep the raw ending even when an
        # earlier structured error exists, instead of silently losing the oversized failure.
        notice = "[stdout diagnostic fallback: oversized log truncated; severity unavailable]\n"
        return notice + raw_tail[-(LOG_CHARS_MAX - len(notice)):]
    return tail


def kill_ingestion_process(process: subprocess.Popen) -> None:
    """Stop the pnpm process and, on POSIX, children holding its output pipes after cancellation."""
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except ProcessLookupError:
        pass
    process.wait()


def run_ingestion_process(
    command: list[str], *, cwd: Path, env: dict[str, str], log
) -> tuple[int, str, str]:
    """Stream both pipes concurrently, returning the exit code and bounded error/stderr tails.

    Each reader logs directly so a slow log sink applies backpressure instead of growing a queue.
    Reading stderr alongside stdout avoids deadlock when either OS pipe fills up.
    """
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="ingestion-log") as readers:
        with subprocess.Popen(
            command, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", start_new_session=os.name == "posix",
        ) as process:
            try:
                stdout = readers.submit(read_process_log, process.stdout, log, stderr=False)
                stderr = readers.submit(read_process_log, process.stderr, log, stderr=True)
                done, _ = wait((stdout, stderr), return_when=FIRST_EXCEPTION)
                for result in done:
                    result.result()
                return process.wait(), stdout.result(), stderr.result()
            except BaseException:
                # Kill before joining readers, to unblock a reader waiting for the child's EOF.
                kill_ingestion_process(process)
                raise


def build_ingestion_asset(source: str, table: str) -> dg.AssetsDefinition:
    @dg.asset(
        key=[source, table],
        group_name="ingestion",
        kinds={"typescript", "postgres"},
    )
    def _ingest(context: dg.AssetExecutionContext) -> dg.MaterializeResult:
        returncode, errors, stderr = run_ingestion_process(
            ["pnpm", "--silent", "ingest"],
            cwd=package_dir(source, table),
            # The source writes the run id into ops.ingestion_runs, next to the dbt results of the same run.
            # CHAIN tells a package that loads several chains which one this asset is.
            env={**os.environ, "DAGSTER_RUN_ID": context.run_id, "CHAIN": source},
            log=context.log,
        )
        if returncode != 0:
            raise dg.Failure(
                description=f"Ingestion for {source} exited with code {returncode}",
                metadata={
                    "errors": dg.MetadataValue.text(errors),
                    "stderr": dg.MetadataValue.text(stderr),
                },
            )
        return dg.MaterializeResult()

    return _ingest


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
