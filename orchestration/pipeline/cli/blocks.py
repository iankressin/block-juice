"""bj blocks: the block range of a chain that covers a time window: EVM or TRON blocks, or Solana slots."""

import json
import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import cache
from typing import NamedTuple

import requests

from pipeline.cli import BadInput, utc_iso
from pipeline import portal
from pipeline.portal import DATASETS_URL, call, ok


@dataclass(frozen=True)
class Chain:
    dataset: str
    # The `type` of a Portal stream query on the dataset.
    kind: str = "evm"
    # Portal gives TRON block timestamps in milliseconds, and every other chain's in seconds.
    units_per_second: int = 1


# The chains bj blocks reads, by the name a source gives its chain before the dot, with their SQD Portal
# datasets. Each dataset is in Portal's own list, GET https://portal.sqd.dev/datasets.
CHAINS = {
    "arbitrum": Chain("arbitrum-one"),
    "avalanche": Chain("avalanche-mainnet"),
    "base": Chain("base-mainnet"),
    "bsc": Chain("binance-mainnet"),
    "ethereum": Chain("ethereum-mainnet"),
    "gnosis": Chain("gnosis-mainnet"),
    "linea": Chain("linea-mainnet"),
    "optimism": Chain("optimism-mainnet"),
    "polygon": Chain("polygon-mainnet"),
    "solana": Chain("solana-mainnet", kind="solana"),
    "tron": Chain("tron-mainnet", kind="tron", units_per_second=1000),
    "unichain": Chain("unichain-mainnet"),
    "zksync": Chain("zksync-mainnet"),
}


@dataclass(frozen=True)
class BlockRange:
    from_block: int
    to_block: int
    to_is_head: bool


def around(time: int, guess: int, head: int, timestamp_of: Callable[[int], int]) -> tuple[int, int]:
    """Blocks low and high with low <= the first block at or after `time` <= high, found by stepping
    away from `guess` in steps that double."""
    step = 1
    if timestamp_of(guess) >= time:
        high = guess
        while high > 0:
            probe = max(guess - step, 0)
            if timestamp_of(probe) < time:
                return probe + 1, high
            high, step = probe, step * 2
        return 0, 0
    low = guess + 1
    while low <= head:
        probe = min(guess + step, head)
        if timestamp_of(probe) >= time:
            return low, probe
        low, step = probe + 1, step * 2
    return head + 1, head + 1


def first_block_at_or_after(time: int, head: int, timestamp_of: Callable[[int], int], guess: int | None = None) -> int:
    """The first block whose timestamp is at or after `time`, or head + 1 when every block is earlier.
    Block timestamps never decrease, so a binary search over 0..head finds it. A guess near that block
    narrows the search to the blocks around it first."""
    low, high = 0, head + 1
    if guess is not None:
        low, high = around(time, min(max(guess, 0), head), head, timestamp_of)
    while low < high:
        middle = (low + high) // 2
        if timestamp_of(middle) >= time:
            high = middle
        else:
            low = middle + 1
    return low


def block_range(
    start: int, end: int, head: int, timestamp_of: Callable[[int], int], guess: Callable[[int], int] | None = None
) -> BlockRange:
    """The first block at or after `start` and the last block before `end`, or the head when `end`
    is past it. Times are unix seconds. `guess` gives a block near the first block at or after a time."""
    from_block = first_block_at_or_after(start, head, timestamp_of, guess(start) if guess else None)
    if from_block > head:
        raise BadInput(
            f"no block at or after {utc_iso(datetime.fromtimestamp(start, timezone.utc))}:"
            f" the head, block {head}, is earlier"
        )
    after_end = first_block_at_or_after(end, head, timestamp_of, guess(end) if guess else None)
    return BlockRange(from_block=from_block, to_block=after_end - 1, to_is_head=after_end > head)


def parse_time(text: str) -> datetime:
    """An ISO 8601 date or datetime. One without an offset is UTC."""
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise BadInput(f"{text!r} is not an ISO 8601 date or datetime") from None
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def unix_seconds(moment: datetime) -> int:
    # Block timestamps are whole seconds, so rounding up keeps both bounds exact.
    return math.ceil(moment.timestamp())


class Header(NamedTuple):
    number: int
    # Unix seconds.
    timestamp: int


# A chain as bj blocks reads it: the head block number, a function giving the first block at or after a
# block number, and an optional guess at the first block at or after a time.
Reader = tuple[int, Callable[[int], Header], Callable[[int], int] | None]


def read_portal(chain: Chain) -> Reader:
    """The chain's head and blocks from its Portal dataset, with Portal's time-to-block route as the guess.
    That route is only a guess: on tron-mainnet it answers blocks minutes early. Solana skips slots, and
    Portal sends only the slots that hold a block, so the first block at or after a skipped slot is a
    later slot. On every other chain it is the block itself."""
    session = portal.session()
    url = f"{DATASETS_URL}/{chain.dataset}"
    found: dict[int, Header] = {}

    def stream(first: int, last: int) -> list[Header]:
        query = {
            "type": chain.kind,
            "fromBlock": first,
            "toBlock": last,
            "includeAllBlocks": True,
            "fields": {"block": {"number": True, "timestamp": True}},
        }
        response = ok(call(session, "POST", f"{url}/stream", json=query), chain.dataset)
        headers = [json.loads(line)["header"] for line in response.text.splitlines()]
        for header in headers:
            if header["timestamp"] is None:
                raise BadInput(f"Portal {chain.dataset} sent block {header['number']} without a timestamp")
        return [Header(header["number"], header["timestamp"] // chain.units_per_second) for header in headers]

    def at_or_after(block: int) -> Header:
        assert 0 <= block <= head, f"block {block} is outside 0..{head}"
        # The block before comes in the same request: after a right guess, the search reads it next. A run
        # of skipped slots widens the request, in steps that double, up to the head, which Portal always has.
        first = max(block - 1, 0)
        for doublings in range(64):
            if block in found:
                break
            last = min(block + 2**doublings - 1, head)
            headers = stream(first, last)
            for number in (first, block):
                later = next((header for header in headers if header.number >= number), None)
                if later is not None:
                    found[number] = later
            if last == head:
                break
        if block not in found:
            raise BadInput(f"Portal {chain.dataset} sent no block from {block} to its head, block {head}")
        return found[block]

    def guess(time: int) -> int:
        response = call(session, "GET", f"{url}/timestamps/{time}/block")
        # Portal answers 404 for a time after its head.
        return head + 1 if response.status_code == 404 else ok(response, chain.dataset).json()["block_number"]

    head = ok(call(session, "GET", f"{url}/head"), chain.dataset).json()["number"]
    return head, at_or_after, guess


def read_chain(url: str) -> Reader:
    """The head and blocks of an EVM chain over JSON-RPC, with no guess."""
    # A plain session: the Portal key must never reach an RPC host the user names.
    session = requests.Session()

    def get_block(tag: str) -> dict:
        response = session.post(
            url,
            json={"jsonrpc": "2.0", "id": 1, "method": "eth_getBlockByNumber", "params": [tag, False]},
            timeout=30,
        )
        response.raise_for_status()
        body = response.json()
        if body.get("error") or not body.get("result"):
            raise BadInput(f"eth_getBlockByNumber({tag}) at {url} returned {body.get('error') or 'no block'}")
        return body["result"]

    @cache
    def at_or_after(block: int) -> Header:
        return Header(block, int(get_block(hex(block))["timestamp"], 16))

    head = int(get_block("latest")["number"], 16)
    return head, at_or_after, None


def run(name: str, start_text: str, end_text: str | None, rpc: str | None = None) -> int:
    if name not in CHAINS:
        raise BadInput(
            f"{name!r} is not a chain bj blocks reads (supported: {', '.join(CHAINS)})."
            " Bitcoin sources read current state only, so they have no block range"
        )
    chain = CHAINS[name]
    if rpc and chain.kind != "evm":
        raise BadInput(f"--rpc reads an EVM JSON-RPC endpoint, and {name} is not EVM; leave it out to read Portal")
    start = parse_time(start_text)
    end = parse_time(end_text) if end_text else datetime.now(timezone.utc)
    if end <= start:
        raise BadInput(f"<to> ({utc_iso(end)}) must be after <from> ({utc_iso(start)})")
    try:
        head, at_or_after, guess = read_chain(rpc) if rpc else read_portal(chain)
        found = block_range(
            unix_seconds(start), unix_seconds(end), head, lambda block: at_or_after(block).timestamp, guess
        )
        # The search can stop on a skipped Solana slot. The window starts at the next slot that holds a block,
        # which is where a source's START_BLOCK sits. Its last slot always holds one.
        from_block = at_or_after(found.from_block).number
    except (requests.RequestException, ValueError, KeyError) as error:
        raise BadInput(f"could not read blocks from {rpc or f'Portal {chain.dataset}'}: {error}") from None
    print(
        json.dumps(
            {
                "chain": name,
                "from": {"time": utc_iso(start), "block": from_block},
                "to": {"time": utc_iso(end), "block": found.to_block, "head": found.to_is_head},
            },
            indent=2,
        )
    )
    return 0
