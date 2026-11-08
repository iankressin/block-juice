"""A Portal that serves one chain held in memory, over the routes bj blocks reads, so tests need no network."""

import json
import re


class FakeResponse:
    def __init__(self, status_code, body=None, lines=None, headers=None):
        self.status_code = status_code
        self.headers = headers or {}
        self.body = body
        # A stream of no blocks is an empty body, as Portal sends for a run of skipped slots.
        self.text = "\n".join(json.dumps(line) for line in lines) if lines is not None else json.dumps(body)

    def json(self):
        return self.body


class FakePortal:
    """Block n has timestamp timestamps[n], in units of 1/units_per_second seconds; None is a skipped
    Solana slot, which Portal never sends. Portal's time-to-block route answers the first block at or after
    a time, moved by `guess_offset` to stand for a dataset that resolves times only roughly. The first
    `overloaded` requests get 529, as Portal answers when it is busy."""

    def __init__(self, timestamps, guess_offset=0, overloaded=0, units_per_second=1):
        assert timestamps[-1] is not None, "the head is a block"
        self.timestamps = timestamps
        self.guess_offset = guess_offset
        self.overloaded = overloaded
        self.units_per_second = units_per_second
        self.requests = []

    @property
    def head(self):
        return len(self.timestamps) - 1

    def request(self, method, url, json=None, **kwargs):
        dataset, route = url.split("/datasets/", 1)[1].split("/", 1)
        self.requests.append((method, dataset, route, json))
        if self.overloaded:
            self.overloaded -= 1
            return FakeResponse(529, {"error": {"code": "overloaded"}}, headers={"retry-after": "0"})
        if route == "head":
            return FakeResponse(200, {"number": self.head, "hash": f"0x{self.head:064x}"})
        if found := re.fullmatch(r"timestamps/(\d+)/block", route):
            time = int(found[1]) * self.units_per_second
            block = next((n for n, at in enumerate(self.timestamps) if at is not None and at >= time), None)
            if block is None:
                return FakeResponse(404, {"error": {"code": "not_found", "message": "block not in hotblocks"}})
            return FakeResponse(200, {"block_number": min(max(block + self.guess_offset, 0), self.head)})
        if route == "stream":
            # With no data asked for, Portal sends every block only under includeAllBlocks, and else the last.
            first = json["fromBlock"] if json.get("includeAllBlocks") else json["toBlock"]
            blocks = [n for n in range(first, json["toBlock"] + 1) if self.timestamps[n] is not None]
            return FakeResponse(200, lines=[{"header": {"number": n, "timestamp": self.timestamps[n]}} for n in blocks])
        return FakeResponse(404, {"error": {"code": "not_found"}})
