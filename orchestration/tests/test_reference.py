from dataclasses import replace
from decimal import Decimal

import pytest

from pipeline.analysis.reference import Reference, mismatches
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
