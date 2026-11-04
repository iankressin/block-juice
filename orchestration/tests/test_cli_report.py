import json
import re

import openpyxl
import pytest

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


def test_missing_answer_md_is_bad_input_and_writes_nothing(answered):
    root, folder = answered
    (folder / "answer.md").unlink()
    with pytest.raises(BadInput, match="answer.md does not exist: write the answer there first"):
        run(root, "top-wallets")
    assert not (folder / "reports").exists()


def test_unknown_format_exits_2(answered, monkeypatch, capsys):
    root, _ = answered
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", root)
    assert main(["report", "top-wallets", "--format", "docx"]) == 2
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
