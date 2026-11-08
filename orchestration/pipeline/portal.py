"""SQD Portal over HTTP, for bj blocks and bj answer: requests that wait out a busy Portal, and a
dataset's finalized head."""

import os
from dataclasses import dataclass
from time import sleep

import requests

from pipeline.cli import BadInput

DATASETS_URL = "https://portal.sqd.dev/datasets"
# Portal answers these when it is overloaded or has no worker free, with the seconds to wait in Retry-After.
BUSY = (429, 503, 529)
ATTEMPTS = 5
# The longest wait for one busy answer, whatever Retry-After asks for.
MAX_WAIT_SECONDS = 30.0


@dataclass(frozen=True)
class FinalizedHead:
    """The last block a Portal dataset calls final, as it answered at one moment."""

    portal_url: str
    number: int
    hash: str


def session() -> requests.Session:
    """A session for Portal. It sends PORTAL_API_KEY in x-api-key when the key is set, as the sources do,
    so a keyed Portal answers at the key's limits instead of the anonymous ones."""
    portal = requests.Session()
    key = os.environ.get("PORTAL_API_KEY", "")
    if key:
        portal.headers["x-api-key"] = key
    return portal


def wait_seconds(response: requests.Response) -> float:
    """Retry-After in seconds, capped at MAX_WAIT_SECONDS. A missing or unreadable value, such as an HTTP
    date, waits one second."""
    try:
        seconds = float(response.headers.get("retry-after") or 1)
    except ValueError:
        seconds = 1.0
    return min(max(seconds, 0.0), MAX_WAIT_SECONDS)


def call(session: requests.Session, method: str, url: str, **kwargs) -> requests.Response:
    """Portal's answer, after waiting out as many as ATTEMPTS - 1 busy answers."""
    for attempt in range(ATTEMPTS):
        response = session.request(method, url, timeout=30, **kwargs)
        if response.status_code not in BUSY or attempt == ATTEMPTS - 1:
            break
        sleep(wait_seconds(response))
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
