"""blockjuice, or bj: the mechanical steps of answering a question from the warehouse.

Exit codes: 0 success, 1 the command ran but a check failed (only `answer`), 2 bad input or
config, reported as one line on stderr, with nothing written.
"""

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[3]


class BadInput(Exception):
    """Bad input or config. main prints the message as one line and exits 2."""


def utc_iso(moment: datetime) -> str:
    """ISO 8601 in UTC, ending in Z. A datetime without an offset is already UTC."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


# Each command imports its module only when it runs, so `bj blocks` does not load dbt or Dagster.
def _answer(args: argparse.Namespace) -> int:
    from pipeline.cli import answer

    return answer.run(REPO_ROOT, args.slug)


def _blocks(args: argparse.Namespace) -> int:
    from pipeline.cli import blocks

    return blocks.run(args.chain, args.start, args.end, rpc=args.rpc)


def _new_source(args: argparse.Namespace) -> int:
    from pipeline.cli import new_source

    return new_source.run(REPO_ROOT, args.source, args.table, args.like)


def _report(args: argparse.Namespace) -> int:
    from pipeline.cli import report

    return report.run(REPO_ROOT, args.slug, args.format)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="The mechanical steps of answering a question about chain data.")
    commands = root.add_subparsers(dest="command", required=True, metavar="<command>")

    answer = commands.add_parser(
        "answer",
        help="run a question's dbt analyses and check the data behind them",
        description="Reads answers/<slug>/question.yaml, compiles and runs its dbt analyses on the warehouse, "
        "runs the dbt tests upstream of them, checks the dead letters and freshness of every raw table they "
        "read, and writes answers/<slug>/results/ and answer.json. Exits 1 when a check fails.",
    )
    answer.add_argument("slug")
    answer.set_defaults(run=_answer)

    blocks = commands.add_parser(
        "blocks",
        help="the block range of an EVM chain that covers a time window",
        description="Prints the first block at or after <from> and the last block before <to>, as JSON. "
        "Times are ISO 8601 dates or datetimes, read as UTC. Without <to>, the range runs to the head.",
    )
    blocks.add_argument("chain")
    blocks.add_argument("start", metavar="from")
    blocks.add_argument("end", metavar="to", nargs="?")
    blocks.add_argument("--rpc", metavar="URL", help="JSON-RPC endpoint (default: eRPC at localhost:$ERPC_PORT)")
    blocks.set_defaults(run=_blocks)

    new_source = commands.add_parser(
        "new-source",
        help="add a source: copy a source package, add its dbt source and its Dagster asset",
        description="Copies ingestion/sources/<package> to a new package for <source>.<table>, adds the table "
        "to the dbt sources of <source> with a staging model, and adds the pair to SOURCES.",
    )
    new_source.add_argument("source")
    new_source.add_argument("table")
    new_source.add_argument("--like", metavar="<package>", required=True, help="the package under ingestion/sources/ to copy")
    new_source.set_defaults(run=_new_source)

    report = commands.add_parser(
        "report",
        help="write an answer as an XLSX workbook and a PDF",
        description="Reads answers/<slug>/answer.json, answer.md and results/, and writes "
        "answers/<slug>/reports/<slug>.xlsx and .pdf.",
    )
    report.add_argument("slug")
    report.add_argument("--format", default="xlsx,pdf", help="comma-separated: xlsx, pdf (default: both)")
    report.set_defaults(run=_report)

    return root


def main(argv: list[str] | None = None) -> int:
    load_dotenv(REPO_ROOT / ".env", override=False)
    cli = parser()
    args = cli.parse_args(argv)
    try:
        return args.run(args)
    except BadInput as error:
        print(f"{cli.prog}: error: {error}", file=sys.stderr)
        return 2
