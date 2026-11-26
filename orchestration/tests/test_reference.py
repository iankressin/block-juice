from dataclasses import replace
from datetime import date
from decimal import Decimal

import pytest

from pipeline.analysis.domain import Check, Result
from pipeline.analysis.reference import Reference, mismatches, reference_check
from pipeline.cli import BadInput

REFERENCE = Reference("by_day", ("day", "token"), "amount", "absolute", Decimal("0"))


def rows(*cells):
    return [{"day": day, "token": token, "amount": amount} for day, token, amount in cells]


def reasons(expected, actual, reference=REFERENCE):
    return [(m.key, m.reason) for m in mismatches(expected, actual, reference)]


def test_equal_rows_in_any_order_match():
    expected = rows(("2026-11-07", "usdt", "1.50"), ("2026-11-07", "eth", "2"))
    assert reasons(expected, rows(("2026-11-07", "eth", "2.0"), ("2026-11-07", "usdt", "1.5"))) == []


@pytest.mark.parametrize("expected, actual, reason", [
    (rows(("d", "eth", "1"), ("d", "eth", "1")), rows(("d", "eth", "1")), "duplicate_in_expected"),
    (rows(("d", "eth", "1")), rows(("d", "eth", "1"), ("d", "eth", "1")), "duplicate_in_actual"),
    (rows(("d", "eth", "1")), [], "missing_in_actual"),
    ([], rows(("d", "eth", "1")), "missing_in_expected"),
    (rows(("d", "eth", "1")), rows(("d", "eth", "")), "over_tolerance"),
    (rows(("d", "eth", "1")), rows(("d", "eth", "2")), "over_tolerance"),
])
def test_each_kind_of_mismatch_has_its_reason(expected, actual, reason):
    assert reasons(expected, actual) == [(("d", "eth"), reason)]


def test_two_empty_values_match():
    assert reasons(rows(("d", "eth", "")), rows(("d", "eth", ""))) == []


def test_a_relative_tolerance_is_a_share_of_the_expected_value_and_absolute_at_zero():
    relative = replace(REFERENCE, kind="relative", tolerance=Decimal("0.001"))
    assert reasons(rows(("d", "eth", "1000")), rows(("d", "eth", "1001")), relative) == []
    assert reasons(rows(("d", "eth", "1000")), rows(("d", "eth", "1001.1")), relative) == [(("d", "eth"), "over_tolerance")]
    assert reasons(rows(("d", "eth", "0")), rows(("d", "eth", "0.001")), relative) == []
    assert reasons(rows(("d", "eth", "0")), rows(("d", "eth", "0.002")), relative) == [(("d", "eth"), "over_tolerance")]


def test_wei_amounts_differ_at_the_last_digit():
    wei = "131322925334691899062636000000000001"
    assert reasons(rows(("d", "eth", wei)), rows(("d", "eth", wei[:-1] + "2"))) == [(("d", "eth"), "over_tolerance")]


def test_key_cells_compare_as_numbers_and_hex_ignores_case():
    assert reasons(rows(("100", "0xAbC", "1")), rows(("100.0", "0xabc", "1"))) == []
    assert reasons(rows(("d", "ETH", "1")), rows(("d", "eth", "1"))) == [
        (("d", "ETH"), "missing_in_actual"), (("d", "eth"), "missing_in_expected")]


def test_a_value_that_is_not_a_number_is_bad_input():
    with pytest.raises(BadInput, match="amount.*'n/a'"):
        mismatches(rows(("d", "eth", "n/a")), rows(("d", "eth", "1")), REFERENCE)


def test_a_missing_column_is_bad_input():
    with pytest.raises(BadInput, match="reference.csv has no column token"):
        mismatches([{"day": "d", "amount": "1"}], rows(("d", "eth", "1")), REFERENCE)
    with pytest.raises(BadInput, match="the analysis by_day returns no column amount"):
        mismatches(rows(("d", "eth", "1")), [{"day": "d", "token": "eth"}], REFERENCE)


def test_keys_that_mix_numbers_and_text_still_sort():
    found = reasons(rows(("1", "eth", "1"), ("d", "eth", "1")), [])
    assert found == [(("1", "eth"), "missing_in_actual"), (("d", "eth"), "missing_in_actual")]


def test_a_relative_limit_on_a_wide_amount_is_exact():
    wei = "131322925334691899062636000000000001"
    relative = replace(REFERENCE, kind="relative", tolerance=Decimal("0.1"))
    on_the_limit = "144455217868161088968899600000000001.1"
    over_the_limit = "144455217868161088968899600000000001.2"
    assert reasons(rows(("d", "eth", wei)), rows(("d", "eth", on_the_limit)), relative) == []
    assert reasons(rows(("d", "eth", wei)), rows(("d", "eth", over_the_limit)), relative) == [(("d", "eth"), "over_tolerance")]


def result(columns, rows, csv_path=None):
    return Result("by_day", "select 1", columns, rows, csv_path)


def test_the_check_reads_reference_csv_and_the_analysis_rows(tmp_path):
    (tmp_path / "reference.csv").write_bytes("\ufeffday,token,amount\r\n2026-11-07,eth,1.5\r\n".encode())
    actual = result(["day", "token", "amount", "txs"], [(date(2026, 11, 7), "eth", Decimal("1.50"), 3)])
    assert reference_check(tmp_path, [actual], REFERENCE) == Check("reference_match", True, "0 mismatches over tolerance")


def test_the_check_fails_and_shows_the_first_mismatches(tmp_path):
    (tmp_path / "reference.csv").write_text("day,token,amount\n2026-11-07,eth,1.5\n2026-11-07,usdt,2\n")
    check = reference_check(tmp_path, [result(["day", "token", "amount"], [])], REFERENCE)
    assert check == Check("reference_match", False, "2 mismatches over tolerance; first: "
                          "(2026-11-07, eth) missing_in_actual, (2026-11-07, usdt) missing_in_actual")


def test_the_check_reads_rows_spooled_to_a_file(tmp_path):
    (tmp_path / "reference.csv").write_text("day,token,amount\n2026-11-07,eth,1.5\n")
    spooled = tmp_path / "by_day.csv"
    spooled.write_text("day,token,amount\n2026-11-07,eth,1.5\n")
    assert reference_check(tmp_path, [result(["day", "token", "amount"], [], spooled)], REFERENCE).passed


def test_the_check_names_a_missing_column_even_when_a_side_has_no_rows(tmp_path):
    (tmp_path / "reference.csv").write_text("day,token\n")
    with pytest.raises(BadInput, match="reference.csv has no column amount"):
        reference_check(tmp_path, [result(["day", "token", "amount"], [])], REFERENCE)
    (tmp_path / "reference.csv").write_text("day,token,amount\n")
    with pytest.raises(BadInput, match="the analysis by_day returns no column amount"):
        reference_check(tmp_path, [result(["day", "token"], [])], REFERENCE)
    spooled = tmp_path / "by_day.csv"
    spooled.write_text("day,token\n")
    with pytest.raises(BadInput, match="the analysis by_day returns no column amount"):
        reference_check(tmp_path, [result(["day", "token"], [], spooled)], REFERENCE)


def test_a_row_with_a_missing_or_extra_cell_names_its_line(tmp_path):
    folder = tmp_path / "answers" / "flows"
    folder.mkdir(parents=True)
    (folder / "reference.csv").write_text("day,token,amount\n2026-11-07,eth,1.5\n2026-11-08,eth\n")
    with pytest.raises(BadInput, match=r"answers/flows/reference\.csv: line 3 has fewer cells than the header"):
        reference_check(folder, [result(["day", "token", "amount"], [])], REFERENCE)
    (folder / "reference.csv").write_text("day,token,amount\n2026-11-07,eth,1.5,9\n")
    with pytest.raises(BadInput, match=r"answers/flows/reference\.csv: line 2 has more cells than the header"):
        reference_check(folder, [result(["day", "token", "amount"], [])], REFERENCE)
