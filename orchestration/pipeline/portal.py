"""SQD Portal over HTTP, for bj blocks and bj answer: requests that wait out a busy Portal, and a
dataset's finalized head."""

from dataclasses import dataclass
from time import sleep

import requests

from pipeline.cli import BadInput

DATASETS_URL = "https://portal.sqd.dev/datasets"
# Portal answers these when it is overloaded or has no worker free, with the seconds to wait in Retry-After.
BUSY = (429, 503, 529)
ATTEMPTS = 5


@dataclass(frozen=True)
class FinalizedHead:
    """The last block a Portal dataset calls final, as it answered at one moment."""

    portal_url: str
    number: int
    hash: str


def call(session: requests.Session, method: str, url: str, **kwargs) -> requests.Response:
    """Portal's answer, after waiting out as many as ATTEMPTS - 1 busy answers."""
    for attempt in range(ATTEMPTS):
        response = session.request(method, url, timeout=30, **kwargs)
        if response.status_code not in BUSY or attempt == ATTEMPTS - 1:
            break
        sleep(float(response.headers.get("retry-after") or 1))
    return response


def ok(response: requests.Response, label: str) -> requests.Response:
    if response.status_code != 200:
        raise BadInput(f"Portal {label} answered {response.status_code}: {' '.join(response.text.split())[:300]}")
    return response


def finalized_head(session: requests.Session, portal_url: str) -> FinalizedHead:
    """The dataset's finalized head now. `portal_url` is a source's PORTAL_URL, such as
    https://portal.sqd.dev/datasets/ethereum-mainnet."""
    body = ok(call(session, "GET", f"{portal_url.rstrip('/')}/finalized-head"), portal_url).json()
    number = body.get("number") if isinstance(body, dict) else None
    block_hash = body.get("hash") if isinstance(body, dict) else None
    if not isinstance(number, int) or isinstance(number, bool) or number < 0:
        raise BadInput(f"Portal {portal_url} sent a finalized head without a block number: {body}")
    if not isinstance(block_hash, str) or not block_hash:
        raise BadInput(f"Portal {portal_url} sent a finalized head without a hash: {body}")
    return FinalizedHead(portal_url, number, block_hash)
