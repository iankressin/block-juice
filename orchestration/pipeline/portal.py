"""SQD Portal over HTTP, for bj blocks: requests that wait out a busy Portal."""

from time import sleep

import requests

from pipeline.cli import BadInput

DATASETS_URL = "https://portal.sqd.dev/datasets"
# Portal answers these when it is overloaded or has no worker free, with the seconds to wait in Retry-After.
BUSY = (429, 503, 529)
ATTEMPTS = 5


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
