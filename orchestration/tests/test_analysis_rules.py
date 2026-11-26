"""Rules the analyses and their questions keep, so an answer can be rerun from the repo alone. Factory builds broke
both: their analyses shipped without question.yaml, and wrote the eval window's blocks into the SQL."""

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
SQL_COMMENT = re.compile(r"--[^\n]*|\{#.*?#\}", re.DOTALL)
NUMBER = re.compile(r"(?<![\w.])\d+(?![\w.])")
# Block numbers an analysis means to keep when its window moves, though they equal a bound today.
FIXED_BLOCKS = {
    # The first block of 2026-10-29, the hack's day, where the addresses' code is read. The window starts there too.
    "binance-hack-fbi-eth-2026-11-01": {26294680},
}


def questions(root: Path) -> dict[str, dict]:
    return {path.parent.name: yaml.safe_load(path.read_text()) for path in sorted((root / "answers").glob("*/question.yaml"))}


def window_blocks(window) -> set[int]:
    """Every block bound in a window, in either shape: {chain, blocks: [a, b]} or {blocks: {chain: [a, b]}}."""
    if not isinstance(window, dict):
        return set()
    blocks = window.get("blocks")
    bounds = blocks.values() if isinstance(blocks, dict) else [blocks] if blocks else []
    return {int(block) for pair in bounds for block in pair}


def analyses_writing_their_window(root: Path) -> list[str]:
    """An analysis reads its window through macros/window.sql, so moving an answer to another window is a
    question.yaml change. A bound of its window or eval window written in its SQL breaks that. Other block
    numbers, such as the block a state is read at, are the question's own and may stay."""
    found = []
    for slug, question in questions(root).items():
        bounds = window_blocks(question.get("window")) | window_blocks(question.get("eval_window"))
        bounds -= FIXED_BLOCKS.get(slug, set())
        for name in question.get("analyses") or []:
            sql = SQL_COMMENT.sub("", (root / "answers" / slug / "analyses" / f"{name}.sql").read_text())
            written = sorted(bounds & {int(number) for number in NUMBER.findall(sql)})
            if written:
                found.append(f"{name}.sql writes {', '.join(map(str, written))} from {slug}'s window")
    return found


def test_every_reference_has_its_rows_and_an_eval_window():
    for slug, question in questions(ROOT).items():
        if "reference" in question:
            assert (ROOT / "answers" / slug / "reference.csv").is_file(), slug
            assert "eval_window" in question, slug


def test_no_analysis_writes_its_window_blocks():
    assert analyses_writing_their_window(ROOT) == []


def make_question(root: Path, slug: str, window: dict, analyses: dict[str, str], eval_window: dict | None = None):
    folder = root / "answers" / slug
    folder.mkdir(parents=True)
    document = {"question": "A sample?", "window": window, "analyses": list(analyses)}
    if eval_window:
        document["eval_window"] = eval_window
    (folder / "question.yaml").write_text(yaml.safe_dump(document))
    for name, sql in analyses.items():
        path = root / "answers" / slug / "analyses" / f"{name}.sql"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(sql)


def test_a_window_bound_in_code_is_reported_in_either_window_shape(tmp_path):
    make_question(
        tmp_path,
        "outflows",
        {"chain": "ethereum", "blocks": [26380784, 26387956]},
        {"outflows": "select 1 where block_number between 26380784 and 26387956"},
    )
    make_question(
        tmp_path,
        "flows",
        {"blocks": {"arbitrum": [510496864, 520129273]}},
        {"flows": "select 1"},
        eval_window={"blocks": {"arbitrum": [510496864, 510500000]}},
    )
    (tmp_path / "answers" / "flows" / "analyses" / "flows.sql").write_text("{{ flows('arbitrum', 510500000) }}")
    assert analyses_writing_their_window(tmp_path) == [
        "flows.sql writes 510500000 from flows's window",
        "outflows.sql writes 26380784, 26387956 from outflows's window",
    ]


def test_window_macros_comments_and_other_block_numbers_pass(tmp_path):
    sql = (
        "-- over blocks 26316189 to 26323364\n"
        "{# the window is 26316189 to 26323364 #}\n"
        "{{ flows('ethereum', window_start('ethereum'), window_end('ethereum'), 26294680) }}\n"
        "where amount > 26316189.5 and id = 'x26323364'"
    )
    make_question(tmp_path, "hack", {"chain": "ethereum", "blocks": [26316189, 26323364]}, {"hack": sql})
    assert analyses_writing_their_window(tmp_path) == []
