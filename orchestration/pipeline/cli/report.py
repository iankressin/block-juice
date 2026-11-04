"""bj report: an answer as an XLSX workbook and a PDF, for readers who do not read JSON."""

import csv
import html
import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

import markdown
from fpdf import FPDF
from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Alignment, Font
from openpyxl.worksheet.worksheet import Worksheet

from pipeline.cli import BadInput
from pipeline.cli.question import answer_dir

FORMATS = ("xlsx", "pdf")
PDF_ROWS = 50
# A plain decimal number. Leading zeros make it an identifier, which stays text.
NUMBER = re.compile(r"^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$")
# The PDF core fonts hold Latin-1 only; these read the same in ASCII. Anything else becomes "?".
ASCII = str.maketrans(
    {
        "‘": "'", "’": "'", "‚": "'", "′": "'",
        "“": '"', "”": '"', "„": '"', "″": '"',
        "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "−": "-",
        "…": "...", "•": "*", "→": "->", "←": "<-",
        "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~",
        " ": " ", " ": " ", " ": " ", " ": " ", "​": "",
    }
)


@dataclass(frozen=True)
class Table:
    name: str
    path: str
    columns: list[str]
    rows: list[list[str]]


@dataclass(frozen=True)
class Report:
    answer: dict[str, Any]
    text: str
    tables: list[Table]


def parse_formats(text: str) -> list[str]:
    formats = [part.strip() for part in text.split(",") if part.strip()]
    unknown = [f for f in formats if f not in FORMATS]
    if unknown or not formats:
        raise BadInput(f"--format takes a comma-separated list of {', '.join(FORMATS)}, not {text!r}")
    return formats


def load(folder: Path, slug: str) -> Report:
    answer_json, answer_md = folder / "answer.json", folder / "answer.md"
    if not answer_json.is_file():
        raise BadInput(f"answers/{slug}/answer.json does not exist: run `bj answer {slug}` first")
    if not answer_md.is_file():
        raise BadInput(f"answers/{slug}/answer.md does not exist: write the answer there first")
    try:
        answer = json.loads(answer_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise BadInput(f"answers/{slug}/answer.json is not valid JSON ({error}): run `bj answer {slug}` again") from None
    tables = []
    for result in answer["results"]:
        path = folder / result["path"]
        if not path.is_file():
            raise BadInput(f"answers/{slug}/{result['path']} does not exist: run `bj answer {slug}` again")
        with open(path, newline="", encoding="utf-8") as file:
            columns, *rows = csv.reader(file)
        tables.append(Table(result["analysis"], result["path"], columns, rows))
    return Report(answer, answer_md.read_text(encoding="utf-8"), tables)


def cell_value(text: str) -> str | int | float | None:
    """A CSV cell as a number when a float holds it exactly in at most 15 significant digits, else as text,
    so a balance in wei keeps every digit."""
    if text == "":
        return None
    if not NUMBER.match(text):
        return text
    number = float(text)
    if Decimal(format(number, ".15g")) != Decimal(text):
        return text
    return int(text) if text.lstrip("-").isdigit() else number


def value_cell(answer: dict[str, Any]) -> Any:
    value = answer["value"]
    return cell_value(value) if isinstance(value, str) else value


def paragraphs(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"\n\s*\n", text.strip()) if part.strip()]


def input_rows(answer: dict[str, Any]) -> list[list[Any]]:
    rows = []
    for item in answer["inputs"]:
        run = item["last_run"] or {}
        rows.append(
            [
                item["source"],
                item["raw_table"],
                run.get("finished_at", "never"),
                run.get("records_written"),
                run.get("dagster_run_id"),
                item["dead_letters"]["pending"],
                item["dead_letters"]["parked"],
            ]
        )
    return rows


INPUT_COLUMNS = ["Source", "Raw table", "Last successful run", "Records", "Dagster run", "Pending", "Parked"]


BOLD = Font(bold=True)
WRAP = Alignment(wrap_text=True, vertical="top")


def append_row(sheet: Worksheet, values: Iterable[Any], *, bold: bool = False, wrap: bool = False) -> None:
    """Appends values as cells, every string as text. openpyxl writes a string starting with = as a
    formula, and result cells and answer.md can hold chain data that anyone sets, such as token names."""
    sheet.append([ILLEGAL_CHARACTERS_RE.sub("�", v) if isinstance(v, str) else v for v in values])
    for cell in sheet[sheet.max_row]:
        if isinstance(cell.value, str):
            cell.data_type = "s"
        if bold:
            cell.font = BOLD
        if wrap:
            cell.alignment = WRAP


def write_xlsx(report: Report, path: Path) -> None:
    answer = report.answer
    book = Workbook()
    sheet = book.active
    sheet.title = "Answer"

    def section(title: str, columns: list[str] | None, rows: Iterable[Iterable[Any]]) -> None:
        sheet.append([])
        append_row(sheet, [title], bold=True)
        if columns:
            append_row(sheet, columns, bold=True)
        for row in rows:
            append_row(sheet, row, wrap=True)

    for label, value in (
        ("Question", answer["question"]),
        ("Value", value_cell(answer)),
        ("Answered at", answer["answered_at"]),
    ):
        append_row(sheet, [label, value], wrap=True)
        sheet.cell(sheet.max_row, 1).font = BOLD
    section("Answer", None, ([paragraph] for paragraph in paragraphs(report.text)))
    section("Definitions", ["Term", "Definition"], answer["definitions"].items())
    section("Checks", ["Check", "Status", "Detail"], ([c["name"], c["status"], c["detail"]] for c in answer["checks"]))
    section("Inputs", INPUT_COLUMNS, input_rows(answer))
    section("Provenance", None, answer["provenance"].items())
    sheet.column_dimensions["A"].width = 60
    sheet.column_dimensions["B"].width = 60
    sheet.column_dimensions["C"].width = 60

    for table in report.tables:
        result = book.create_sheet(table.name[:31])
        append_row(result, table.columns, bold=True)
        for row in table.rows:
            append_row(result, [cell_value(text) for text in row])
        result.freeze_panes = "A2"
    book.save(path)


def latin1(text: str) -> str:
    return str(text).translate(ASCII).encode("latin-1", "replace").decode("latin-1")


def markdown_html(text: str) -> str:
    """answer.md as HTML, with no raw HTML and no images: fpdf2 opens the file or URL of any <img>."""
    converter = markdown.Markdown(extensions=["tables"])
    converter.preprocessors.deregister("html_block")
    for pattern in ("html", "image_link", "image_reference", "short_image_ref"):
        converter.inlinePatterns.deregister(pattern)
    return converter.convert(text)


def write_pdf(report: Report, path: Path) -> None:
    answer = report.answer
    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(True, margin=15)
    pdf.add_page()

    def heading(text: str, size: int = 13) -> None:
        pdf.ln(3)
        pdf.set_font("Helvetica", "B", size)
        pdf.multi_cell(0, size * 0.5, latin1(text), new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", size=10)

    def line(text: str) -> None:
        pdf.multi_cell(0, 5, latin1(text), new_x="LMARGIN", new_y="NEXT")

    def table(columns: list[str], rows: Iterable[Iterable[Any]]) -> None:
        pdf.set_font("Helvetica", size=7)
        with pdf.table(text_align="LEFT", line_height=3.5) as grid:
            for cells in [columns, *rows]:
                row = grid.row()
                for cell in cells:
                    row.cell(latin1("" if cell is None else cell))
        pdf.set_font("Helvetica", size=10)

    heading(answer["question"], size=16)
    value = answer["value"]
    line(f"Value: {'none' if value is None else value}")
    line(f"Answered at {answer['answered_at']}")
    pdf.ln(2)
    pdf.write_html(latin1(markdown_html(report.text)))

    if answer["definitions"]:
        heading("Definitions")
        pdf.write_html(
            latin1("".join(f"<p><b>{html.escape(k)}</b>: {html.escape(v)}</p>" for k, v in answer["definitions"].items()))
        )
    heading("Checks")
    table(["Check", "Status", "Detail"], ([c["name"], c["status"], c["detail"]] for c in answer["checks"]))
    for result in report.tables:
        heading(result.name)
        table(result.columns, result.rows[:PDF_ROWS])
        shown = f", the first {PDF_ROWS} shown above" if len(result.rows) > PDF_ROWS else ""
        line(f"{result.path} has {len(result.rows)} row{'s' if len(result.rows) != 1 else ''}{shown}.")
    heading("Provenance")
    for key, value in answer["provenance"].items():
        line(f"{key}: {value}")
    pdf.output(str(path))


WRITERS = {"xlsx": write_xlsx, "pdf": write_pdf}


def run(repo_root: Path, slug: str, formats: str = "xlsx,pdf") -> int:
    chosen = parse_formats(formats)
    folder = answer_dir(repo_root, slug)
    report = load(folder, slug)
    reports = folder / "reports"
    reports.mkdir(exist_ok=True)
    for name in chosen:
        path = reports / f"{slug}.{name}"
        WRITERS[name](report, path)
        print(f"wrote {path.relative_to(repo_root)}")
    return 0
