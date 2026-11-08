import json

import pytest
from fake_portal import FakePortal

from pipeline.cli import BadInput, main
from pipeline.cli.blocks import BlockRange, Header, block_range, first_block_at_or_after, parse_time, unix_seconds

# Block n has timestamp TIMESTAMPS[n]. Blocks 2 and 3 share a second, as blocks can.
TIMESTAMPS = [100, 112, 124, 124, 136]
HEAD = len(TIMESTAMPS) - 1
# Solana slot n has timestamp SLOTS[n]; None is a skipped slot, which holds no block.
SLOTS = [100, None, None, 112, None, 124, None, None, 136]


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


def test_any_guess_finds_the_same_block_as_no_guess():
    for time in range(95, 140):
        for guess in range(HEAD + 2):
            assert first_block_at_or_after(time, HEAD, fake_chain, guess) == first_block_at_or_after(time, HEAD, fake_chain)


def counted(chain):
    reads = []

    def timestamp_of(block: int) -> int:
        reads.append(block)
        return chain(block)

    return reads, timestamp_of


def test_a_guess_near_the_block_takes_fewer_reads_than_searching_the_whole_chain():
    # Four blocks a second, as on Arbitrum; `first` is the first block of its second.
    head, first = 400_000_000, 123_456_788
    reads, chain = counted(lambda block: 1_000 + block // 4)
    time = 1_000 + first // 4
    assert first_block_at_or_after(time, head, chain) == first
    whole_chain = len(reads)
    for guess, most in ((first, 2), (first + 1, 3), (first + 50, 14), (first - 50, 14)):
        reads.clear()
        assert first_block_at_or_after(time, head, chain, guess) == first
        assert len(reads) <= most < whole_chain


def test_times_without_an_offset_are_utc():
    assert unix_seconds(parse_time("2026-10-01")) == 1_790_812_800
    assert unix_seconds(parse_time("2026-10-01T00:00:00Z")) == 1_790_812_800
    assert unix_seconds(parse_time("2026-10-01T02:00:00+02:00")) == 1_790_812_800


def test_part_of_a_second_rounds_up_to_the_next_block_second():
    assert unix_seconds(parse_time("2026-10-01T00:00:00.5")) == 1_790_812_801


def test_unknown_chain_exits_2_listing_the_chains(capsys):
    assert main(["blocks", "bitcoin", "2026-10-01"]) == 2
    err = capsys.readouterr().err
    assert "'bitcoin' is not a chain bj blocks reads" in err and "solana, tron" in err
    assert "Bitcoin sources read current state only" in err
    assert err.count("\n") == 1


@pytest.mark.parametrize("chain", ["tron", "solana"])
def test_rpc_on_a_chain_that_is_not_evm_exits_2(chain, capsys):
    assert main(["blocks", chain, "2026-10-01", "--rpc", "http://x"]) == 2
    assert f"--rpc reads an EVM JSON-RPC endpoint, and {chain} is not EVM" in capsys.readouterr().err


def test_bad_time_exits_2(capsys):
    assert main(["blocks", "ethereum", "October"]) == 2
    assert "'October' is not an ISO 8601" in capsys.readouterr().err


def test_prints_the_range_as_json(monkeypatch, capsys):
    monkeypatch.setattr(
        "pipeline.cli.blocks.read_chain", lambda url: (HEAD, lambda block: Header(block, fake_chain(block)), None)
    )
    assert main(["blocks", "ethereum", "1970-01-01T00:01:45Z", "1970-01-01T02:46:40Z", "--rpc", "http://x"]) == 0
    assert json.loads(capsys.readouterr().out) == {
        "chain": "ethereum",
        "from": {"time": "1970-01-01T00:01:45Z", "block": 1},
        "to": {"time": "1970-01-01T02:46:40Z", "block": 4, "head": True},
    }


@pytest.fixture
def portal(monkeypatch):
    """Installs a FakePortal of the chain in TIMESTAMPS, or of the given timestamps, as the Portal bj blocks reads."""

    def install(timestamps=TIMESTAMPS, **options):
        fake = FakePortal(timestamps, **options)
        monkeypatch.setattr("pipeline.cli.blocks.requests.Session", lambda: fake)
        return fake

    return install


def blocks_json(capsys, *args):
    assert main(["blocks", *args]) == 0
    return json.loads(capsys.readouterr().out)


def test_reads_the_range_from_the_portal_dataset_of_the_chain(portal, capsys):
    fake = portal()
    assert blocks_json(capsys, "base", "1970-01-01T00:01:45Z", "1970-01-01T00:02:16Z") == {
        "chain": "base",
        "from": {"time": "1970-01-01T00:01:45Z", "block": 1},
        "to": {"time": "1970-01-01T00:02:16Z", "block": 3, "head": False},
    }
    assert {dataset for _, dataset, _, _ in fake.requests} == {"base-mainnet"}
    # Portal often answers a stream request 529 and asks for 10 seconds' wait, so each edge takes one.
    assert len([route for _, _, route, _ in fake.requests if route == "stream"]) == 2


@pytest.mark.parametrize("offset", [-2, 1, 3])
def test_a_rough_portal_guess_still_gives_the_exact_blocks(portal, capsys, offset):
    portal(guess_offset=offset)
    printed = blocks_json(capsys, "arbitrum", "1970-01-01T00:02:04Z", "1970-01-01T00:02:16Z")
    assert (printed["from"]["block"], printed["to"]["block"]) == (2, 3)


def stream_queries(fake):
    return {(dataset, query["type"]) for _, dataset, route, query in fake.requests if route == "stream"}


# Portal's time-to-block route answers TRON blocks minutes early, so a negative offset is the usual case.
@pytest.mark.parametrize("offset", [-2, 0, 1, 3])
def test_tron_reads_millisecond_timestamps_and_checks_portal_guess(portal, capsys, offset):
    fake = portal(timestamps=[at * 1000 for at in TIMESTAMPS], units_per_second=1000, guess_offset=offset)
    printed = blocks_json(capsys, "tron", "1970-01-01T00:02:04Z", "1970-01-01T00:02:16Z")
    assert (printed["from"]["block"], printed["to"]["block"]) == (2, 3)
    assert stream_queries(fake) == {("tron-mainnet", "tron")}


@pytest.mark.parametrize("offset", [-3, 0, 1, 2])
def test_solana_window_starts_and_ends_on_slots_that_hold_a_block(portal, capsys, offset):
    fake = portal(timestamps=SLOTS, guess_offset=offset)
    printed = blocks_json(capsys, "solana", "1970-01-01T00:01:45Z", "1970-01-01T00:02:10Z")
    assert (printed["from"]["block"], printed["to"]["block"]) == (3, 5)
    assert stream_queries(fake) == {("solana-mainnet", "solana")}


def test_a_long_run_of_skipped_slots_widens_the_read_up_to_the_head(portal, capsys):
    portal(timestamps=[100, *[None] * 20, 200])
    printed = blocks_json(capsys, "solana", "1970-01-01T00:02:30Z", "1970-01-01T00:05:00Z")
    assert (printed["from"]["block"], printed["to"]["block"], printed["to"]["head"]) == (21, 21, True)


def test_to_past_the_portal_head_ends_at_the_head(portal, capsys):
    portal()
    assert blocks_json(capsys, "ethereum", "1970-01-01T00:02:10Z", "1970-01-01T02:46:40Z")["to"] == {
        "time": "1970-01-01T02:46:40Z",
        "block": 4,
        "head": True,
    }


def test_waits_out_a_busy_portal(portal, capsys):
    portal(overloaded=3)
    assert blocks_json(capsys, "ethereum", "1970-01-01T00:01:45Z", "1970-01-01T00:02:16Z")["from"]["block"] == 1


def test_a_portal_that_stays_busy_exits_2_with_one_line(portal, capsys):
    portal(overloaded=100)
    assert main(["blocks", "ethereum", "1970-01-01T00:01:45Z"]) == 2
    err = capsys.readouterr().err
    assert "Portal ethereum-mainnet answered 529" in err
    assert err.count("\n") == 1
