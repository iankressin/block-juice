import requests

from pipeline import portal


def busy(retry_after: str | None) -> requests.Response:
    response = requests.Response()
    response.status_code = 529
    if retry_after is not None:
        response.headers["retry-after"] = retry_after
    return response


def test_a_session_sends_the_portal_key_only_when_it_is_set(monkeypatch):
    monkeypatch.setenv("PORTAL_API_KEY", "key-1")
    assert portal.session().headers["x-api-key"] == "key-1"
    monkeypatch.setenv("PORTAL_API_KEY", "")
    assert "x-api-key" not in portal.session().headers
    monkeypatch.delenv("PORTAL_API_KEY")
    assert "x-api-key" not in portal.session().headers


def test_a_busy_answer_waits_what_retry_after_says_up_to_the_cap():
    assert portal.wait_seconds(busy("2")) == 2
    assert portal.wait_seconds(busy(None)) == 1
    assert portal.wait_seconds(busy("Wed, 21 Oct 2026 07:28:00 GMT")) == 1
    assert portal.wait_seconds(busy("3600")) == portal.MAX_WAIT_SECONDS
    assert portal.wait_seconds(busy("-5")) == 0
