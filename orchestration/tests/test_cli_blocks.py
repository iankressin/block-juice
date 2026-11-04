import json

import pytest

from pipeline.cli import BadInput, main
from pipeline.cli.blocks import BlockRange, block_range, parse_time, unix_seconds

# Block n has timestamp TIMESTAMPS[n]. Blocks 2 and 3 share a second, as blocks can.
TIMESTAMPS = [100, 112, 124, 124, 136]
HEAD = len(TIMESTAMPS) - 1


def fake_chain(block: int) -> int:
    return TIMESTAMPS[block]


def test_window_starting_before_the_first_block_starts_at_block_zero():
    assert block_range(50, 113, HEAD, fake_chain) == BlockRange(from_block=0, to_block=1, to_is_head=False)


def test_window_between_blocks_takes_the_blocks_inside_it():
    assert block_range(105, 130, HEAD, fake_chain) == BlockRange(from_block=1, to_block=3, to_is_head=False)


def test_from_on_a_block_includes_it_and_to_on_a_block_excludes_it():
    assert block_range(112, 136, HEAD, fake_chain) == BlockRange(from_block=1, to_block=3, to_is_head=False)
    assert block_range(124, 136, HEAD, fake_chain) == BlockRange(from_block=2, to_block=3, to_is_head=False)


def test_to_past_the_head_ends_at_the_head():
    assert block_range(130, 10_000, HEAD, fake_chain) == BlockRange(from_block=4, to_block=4, to_is_head=True)


def test_from_past_the_head_is_bad_input():
    with pytest.raises(BadInput, match="head, block 4"):
        block_range(137, 10_000, HEAD, fake_chain)


def test_search_reads_a_logarithmic_number_of_blocks():
    reads = []

    def chain(block: int) -> int:
        reads.append(block)
        return 1_000 + 12 * block

    head = 20_000_000
    found = block_range(1_000 + 12 * 1_234_567 - 5, 1_000 + 12 * 7_654_321 + 1, head, chain)
    assert found == BlockRange(from_block=1_234_567, to_block=7_654_321, to_is_head=False)
    assert len(reads) <= 2 * 26


def test_times_without_an_offset_are_utc():
    assert unix_seconds(parse_time("2026-10-01")) == 1_790_812_800
    assert unix_seconds(parse_time("2026-10-01T00:00:00Z")) == 1_790_812_800
    assert unix_seconds(parse_time("2026-10-01T02:00:00+02:00")) == 1_790_812_800


def test_part_of_a_second_rounds_up_to_the_next_block_second():
    assert unix_seconds(parse_time("2026-10-01T00:00:00.5")) == 1_790_812_801


def test_non_evm_chain_exits_2_naming_current_state_only(capsys):
    assert main(["blocks", "solana", "2026-10-01"]) == 2
    err = capsys.readouterr().err
    assert "Solana and Bitcoin" in err and "current state only" in err
    assert err.count("\n") == 1


def test_bad_time_exits_2(capsys):
    assert main(["blocks", "ethereum", "October"]) == 2
    assert "'October' is not an ISO 8601" in capsys.readouterr().err


def test_prints_the_range_as_json(monkeypatch, capsys):
    monkeypatch.setattr("pipeline.cli.blocks.read_chain", lambda url: (HEAD, fake_chain))
    assert main(["blocks", "ethereum", "1970-01-01T00:01:45Z", "1970-01-01T02:46:40Z", "--rpc", "http://x"]) == 0
    assert json.loads(capsys.readouterr().out) == {
        "chain": "ethereum",
        "from": {"time": "1970-01-01T00:01:45Z", "block": 1},
        "to": {"time": "1970-01-01T02:46:40Z", "block": 4, "head": True},
    }
