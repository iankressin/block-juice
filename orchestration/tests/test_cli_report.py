import json
import re
import zipfile

import docx
import openpyxl
import pytest
from docx.table import Table

from pipeline.cli import BadInput, main
from pipeline.cli.report import cell_value, run

BALANCE = "1234567890123456789012345"
ADDRESS = "0x00000000219ab540356cBB839Cbe05303d7705Fa"
LONG_NAME = "balances_of_every_wallet_by_asset_and_chain"

ANSWER = {
    "question": "Which wallets hold the most ETH — and how much?",
    "slug": "top-wallets",
    "answered_at": "2026-11-04T19:00:00Z",
    "value": None,
    "definitions": {"wallet": "An address in addresses.json → one row per asset."},
    "alternatives": [],
    "window": {},
    "results": [
        {"analysis": "top_wallets", "path": "results/top_wallets.csv", "columns": ["wallet", "balance", "share"], "rows": 2, "sql": "select 1"},
        {"analysis": LONG_NAME, "path": f"results/{LONG_NAME}.csv", "columns": ["n"], "rows": 60, "sql": "select 2"},
    ],
    "inputs": [
        {
            "source": "ethereum.eth_balances",
            "raw_table": "raw.ethereum_eth_balances",
            "last_run": {"finished_at": "2026-11-04T06:00:00Z", "records_written": 12, "dagster_run_id": "run-1"},
            "dead_letters": {"pending": 0, "parked": 1},
        }
    ],
    "checks": [
        {"name": "dbt_tests", "status": "passed", "detail": "54 passed"},
        {"name": "dead_letters", "status": "failed", "detail": "ethereum.eth_balances 0 pending, 1 parked"},
        {"name": "freshness", "status": "passed", "detail": "ethereum.eth_balances finished 2026-11-04T06:00:00Z"},
    ],
    "provenance": {"git_sha": "abc123", "git_dirty": False, "dbt_version": "1.12.6"},
}

ANSWER_MD = """# Top wallets

The largest wallet holds **1.23 million ETH** — “the deposit contract”.

- It leads by a wide margin…
- Values are in wei ≈ 10⁻¹⁸ ETH.

| wallet | note |
|---|---|
| deposit | ✓ checked |
"""


@pytest.fixture
def answered(tmp_path):
    folder = tmp_path / "answers" / "top-wallets"
    (folder / "results").mkdir(parents=True)
    (folder / "answer.json").write_text(json.dumps(ANSWER))
    (folder / "answer.md").write_text(ANSWER_MD)
    (folder / "results" / "top_wallets.csv").write_text(f"wallet,balance,share\n{ADDRESS},{BALANCE},0.25\nx,,007\n")
    (folder / "results" / f"{LONG_NAME}.csv").write_text("n\n" + "".join(f"{i}\n" for i in range(60)))
    return tmp_path, folder


def test_xlsx_has_the_answer_sheet_and_one_sheet_per_result(answered):
    root, folder = answered
    assert run(root, "top-wallets", "xlsx") == 0
    book = openpyxl.load_workbook(folder / "reports" / "top-wallets.xlsx")
    assert book.sheetnames == ["Answer", "top_wallets", LONG_NAME[:31]]

    summary = book["Answer"]
    assert summary["A1"].value == "Question"
    assert summary["B1"].value == ANSWER["question"]
    assert summary["A3"].value == "Answered at"
    column_a = [cell.value for cell in summary["A"]]
    assert "The largest wallet holds **1.23 million ETH** — “the deposit contract”." in column_a
    assert {"Answer", "Definitions", "Checks", "Inputs", "Provenance"} <= set(column_a)
    assert ["dead_letters", "failed", "ethereum.eth_balances 0 pending, 1 parked"] in [
        [cell.value for cell in row[:3]] for row in summary.iter_rows()
    ]

    top = book["top_wallets"]
    assert [cell.value for cell in top[1]] == ["wallet", "balance", "share"]
    assert top["A1"].font.bold
    assert top.freeze_panes == "A2"
    assert top["B2"].value == BALANCE
    assert top["B2"].data_type == "s"
    assert top["C2"].value == 0.25
    assert top["A2"].value == ADDRESS
    assert top["B3"].value is None
    assert top["C3"].value == "007"
    assert book[LONG_NAME[:31]]["A61"].value == 59
    assert not (folder / "reports" / "top-wallets.pdf").exists()


def test_pdf_is_a_pdf_with_pages(answered):
    root, folder = answered
    assert run(root, "top-wallets", "pdf") == 0
    data = (folder / "reports" / "top-wallets.pdf").read_bytes()
    assert data.startswith(b"%PDF")
    assert len(re.findall(rb"/Type /Page\b", data)) >= 1


def test_both_formats_by_default_overwriting_old_reports(answered, monkeypatch):
    root, folder = answered
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", root)
    (folder / "reports").mkdir()
    (folder / "reports" / "top-wallets.xlsx").write_text("not a workbook")
    assert main(["report", "top-wallets"]) == 0
    assert sorted(p.name for p in (folder / "reports").iterdir()) == ["top-wallets.pdf", "top-wallets.xlsx"]
    assert openpyxl.load_workbook(folder / "reports" / "top-wallets.xlsx").sheetnames[0] == "Answer"


FORMULA = '=HYPERLINK("http://x","y")'


def test_cells_that_look_like_formulas_stay_text_on_every_sheet(answered):
    root, folder = answered
    (folder / "results" / "top_wallets.csv").write_text(
        f'wallet,balance,share\n"{FORMULA.replace(chr(34), chr(34) * 2)}",+1+1,@SUM(A1)\n-x,\tcmd,"\rcmd"\n'
    )
    answer = json.loads((folder / "answer.json").read_text())
    answer["definitions"] = {"=term": "=1+1"}
    answer["checks"][0]["detail"] = "-2+3"
    (folder / "answer.json").write_text(json.dumps(answer))
    (folder / "answer.md").write_text("=cmd|' /C calc'!A0\n")

    assert run(root, "top-wallets", "xlsx") == 0
    book = openpyxl.load_workbook(folder / "reports" / "top-wallets.xlsx")
    top = book["top_wallets"]
    assert [(c.value, c.data_type) for c in top[2]] == [(FORMULA, "s"), ("+1+1", "s"), ("@SUM(A1)", "s")]
    assert [(c.value, c.data_type) for c in top[3][:2]] == [("-x", "s"), ("\tcmd", "s")]
    # XML parsing turns the CR into LF; what matters is that the cell is text.
    assert (top["C3"].value[1:], top["C3"].data_type) == ("cmd", "s")
    summary = [cell for row in book["Answer"].iter_rows() for cell in row if cell.value is not None]
    assert not [cell.value for cell in summary if cell.data_type == "f"]
    assert {"=term", "=1+1", "-2+3", "=cmd|' /C calc'!A0"} <= {cell.value for cell in summary}


def test_pdf_never_loads_images_or_raw_html_from_answer_md(answered, monkeypatch):
    root, folder = answered
    (folder / "answer.md").write_text(
        '# Answer\n\n<img src="/etc/passwd">\n\nInline <img src="/etc/hosts"> too.\n\n'
        "![x](http://example.com/a.png)\n\n![y][ref]\n\n[ref]: http://example.com/b.png\n\n"
        "- **bold** item\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"
    )

    def refuse(*args, **kwargs):
        raise AssertionError(f"fpdf2 tried to load an image: {args}")

    monkeypatch.setattr("fpdf.FPDF.image", refuse)
    monkeypatch.setattr("fpdf.image_parsing.load_image", refuse)
    assert run(root, "top-wallets", "pdf") == 0
    assert (folder / "reports" / "top-wallets.pdf").read_bytes().startswith(b"%PDF")


def outline(path):
    """The body of a DOCX in order: (style, text) for a paragraph, ("table", rows of cell texts) for a table."""
    document = docx.Document(path)
    return [
        ("table", [[cell.text for cell in row.cells] for row in block.rows])
        if isinstance(block, Table)
        else (block.style.name, block.text)
        for block in document.iter_inner_content()
    ]


def test_docx_has_the_pdf_content_in_the_pdf_order(answered):
    root, folder = answered
    assert run(root, "top-wallets", "docx") == 0
    path = folder / "reports" / "top-wallets.docx"
    checks = [["Check", "Status", "Detail"], *([c["name"], c["status"], c["detail"]] for c in ANSWER["checks"])]
    assert outline(path) == [
        ("Title", ANSWER["question"]),
        ("Normal", "Value: none"),
        ("Normal", "Answered at 2026-11-04T19:00:00Z"),
        ("Heading 1", "Top wallets"),
        ("Normal", "The largest wallet holds 1.23 million ETH — “the deposit contract”."),
        ("List Bullet", "It leads by a wide margin…"),
        ("List Bullet", "Values are in wei ≈ 10⁻¹⁸ ETH."),
        ("table", [["wallet", "note"], ["deposit", "✓ checked"]]),
        ("Heading 2", "Definitions"),
        ("Normal", "wallet: An address in addresses.json → one row per asset."),
        ("Heading 2", "Checks"),
        ("table", checks),
        ("Heading 2", "top_wallets"),
        ("table", [["wallet", "balance", "share"], [ADDRESS, BALANCE, "0.25"], ["x", "", "007"]]),
        ("Normal", "results/top_wallets.csv has 2 rows."),
        ("Heading 2", LONG_NAME),
        ("table", [["n"], *([str(i)] for i in range(50))]),
        ("Normal", f"results/{LONG_NAME}.csv has 60 rows, the first 50 shown above."),
        ("Heading 2", "Provenance"),
        ("Normal", "git_sha: abc123"),
        ("Normal", "git_dirty: False"),
        ("Normal", "dbt_version: 1.12.6"),
    ]
    document = docx.Document(path)
    bold = {run.text for paragraph in document.paragraphs for run in paragraph.runs if run.bold}
    assert {"1.23 million ETH", "wallet"} <= bold
    assert all(cell.paragraphs[0].runs[0].bold for table in document.tables for cell in table.rows[0].cells)
    assert not (folder / "reports" / "top-wallets.pdf").exists()


def test_docx_renders_marks_lists_and_links_from_answer_md(answered):
    root, folder = answered
    (folder / "answer.md").write_text(
        "Plain *italic* and `code` and **bold**, see [the explorer](https://etherscan.io/address/x).\n\n"
        "    select 1\n      from t\n\n"
        "1. first\n2. second\n    - nested\n\n> quoted\n\n"
        "Between the lists.\n\n1. again\n"
    )
    assert run(root, "top-wallets", "docx") == 0
    path = folder / "reports" / "top-wallets.docx"
    assert outline(path)[3:11] == [
        ("Normal", "Plain italic and code and bold, see the explorer (https://etherscan.io/address/x)."),
        ("Normal", "select 1\n  from t"),
        ("List Continue", "1. first"),
        ("List Continue", "2. second"),
        ("List Bullet 2", "nested"),
        ("Quote", "quoted"),
        ("Normal", "Between the lists."),
        ("List Continue", "1. again"),
    ]
    paragraphs = docx.Document(path).paragraphs
    assert [run.font.name for run in paragraphs[4].runs] == ["Courier New"]
    marks = [(run.text, run.italic, run.font.name, run.bold) for run in paragraphs[3].runs]
    assert ("italic", True, None, None) in marks
    assert ("code", None, "Courier New", None) in marks
    assert ("bold", None, None, True) in marks


def test_docx_writes_answer_md_and_chain_data_as_literal_text(answered, monkeypatch):
    root, folder = answered
    (folder / "answer.md").write_text(
        '<div><img src="/etc/shadow"></div>\n\n<img src="/etc/passwd">\n\nInline <img src="/etc/hosts"> too.\n\n'
        "![x](http://example.com/a.png)\n\n![y][ref]\n\n[ref]: http://example.com/b.png\n\n"
        "=cmd|' /C calc'!A0\n"
    )
    (folder / "results" / "top_wallets.csv").write_text(
        f'wallet,balance,share\n"{FORMULA.replace(chr(34), chr(34) * 2)}",+1+1,bell\x07\n'
    )
    answer = json.loads((folder / "answer.json").read_text())
    answer["definitions"] = {"=term": "=1+1"}
    (folder / "answer.json").write_text(json.dumps(answer))

    def refuse(*args, **kwargs):
        raise AssertionError(f"python-docx tried to add an image: {args}")

    monkeypatch.setattr("docx.document.Document.add_picture", refuse)
    monkeypatch.setattr("docx.text.run.Run.add_picture", refuse)
    assert run(root, "top-wallets", "docx") == 0
    path = folder / "reports" / "top-wallets.docx"
    body = outline(path)
    assert body[3:9] == [
        ("Normal", '<div><img src="/etc/shadow"></div>'),
        ("Normal", '<img src="/etc/passwd">'),
        ("Normal", 'Inline <img src="/etc/hosts"> too.'),
        ("Normal", "![x](http://example.com/a.png)"),
        ("Normal", "![y]ref (http://example.com/b.png)"),
        ("Normal", "=cmd|' /C calc'!A0"),
    ]
    assert ("Normal", "=term: =1+1") in body
    assert ("table", [["wallet", "balance", "share"], [FORMULA, "+1+1", "bell\ufffd"]]) in body
    with zipfile.ZipFile(path) as package:
        assert not [name for name in package.namelist() if name.startswith("word/media/")]
        xml = package.read("word/document.xml").decode()
    assert not [tag for tag in ("w:fldSimple", "w:instrText", "w:hyperlink", "w:drawing", "w:pict") if tag in xml]


def test_missing_answer_md_is_bad_input_and_writes_nothing(answered):
    root, folder = answered
    (folder / "answer.md").unlink()
    with pytest.raises(BadInput, match="answer.md does not exist: write the answer there first"):
        run(root, "top-wallets")
    assert not (folder / "reports").exists()


def test_unknown_format_exits_2(answered, monkeypatch, capsys):
    root, _ = answered
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", root)
    assert main(["report", "top-wallets", "--format", "html"]) == 2
    assert "--format takes" in capsys.readouterr().err


@pytest.mark.parametrize(
    "text, value",
    [
        ("12", 12),
        ("-3.5", -3.5),
        ("123456789012345", 123456789012345),
        ("1234567890123456", "1234567890123456"),
        (BALANCE, BALANCE),
        ("0.1", 0.1),
        ("0.12345678901234567", "0.12345678901234567"),
        ("1e400", "1e400"),
        ("007", "007"),
        ("2026-11-04", "2026-11-04"),
        ("", None),
    ],
)
def test_cells_become_numbers_only_when_a_float_holds_them_exactly(text, value):
    assert cell_value(text) == value
    assert type(cell_value(text)) is type(value)
