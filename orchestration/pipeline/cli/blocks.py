"""bj blocks: the block range of an EVM chain that covers a time window."""

import json
import math
import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import cache

import requests

from pipeline.cli import BadInput, utc_iso

# The EVM chains eRPC serves (infra/erpc/erpc.yaml), by name, with their chain ids.
CHAINS = {"ethereum": 1}


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


def block_range(start: int, end: int, head: int, timestamp_of: Callable[[int], int]) -> BlockRange:
    """The first block at or after `start` and the last block before `end`, or the head when `end`
    is past it. Times are unix seconds."""
    from_block = first_block_at_or_after(start, head, timestamp_of)
    if from_block > head:
        raise BadInput(
            f"no block at or after {utc_iso(datetime.fromtimestamp(start, timezone.utc))}:"
            f" the head, block {head}, is earlier"
        )
    after_end = first_block_at_or_after(end, head, timestamp_of)
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


def erpc_url(chain: str) -> str:
    port = os.environ.get("ERPC_PORT")
    if not port:
        raise BadInput("ERPC_PORT is not set: set it in .env or pass --rpc URL")
    return f"http://localhost:{port}/main/evm/{CHAINS[chain]}"


def read_chain(url: str) -> tuple[int, Callable[[int], int]]:
    """The head block number, and a function giving any block's timestamp, over JSON-RPC."""
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
    def timestamp_of(block: int) -> int:
        return int(get_block(hex(block))["timestamp"], 16)

    head = int(get_block("latest")["number"], 16)
    return head, timestamp_of


def run(chain: str, start_text: str, end_text: str | None, rpc: str | None = None) -> int:
    if chain not in CHAINS:
        raise BadInput(
            f"{chain!r} is not a supported EVM chain (supported: {', '.join(CHAINS)})."
            " Solana and Bitcoin sources read current state only, so they have no block range"
        )
    start = parse_time(start_text)
    end = parse_time(end_text) if end_text else datetime.now(timezone.utc)
    if end <= start:
        raise BadInput(f"<to> ({utc_iso(end)}) must be after <from> ({utc_iso(start)})")
    url = rpc or erpc_url(chain)
    try:
        head, timestamp_of = read_chain(url)
        found = block_range(unix_seconds(start), unix_seconds(end), head, timestamp_of)
    except (requests.RequestException, ValueError) as error:
        raise BadInput(f"could not read blocks from {url}: {error}") from None
    print(
        json.dumps(
            {
                "chain": chain,
                "from": {"time": utc_iso(start), "block": found.from_block},
                "to": {"time": utc_iso(end), "block": found.to_block, "head": found.to_is_head},
            },
            indent=2,
        )
    )
    return 0
