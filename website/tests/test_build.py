"""The site builds from the repo, and what it says about the repo is true."""

import json
import re
from pathlib import Path

import pytest

import build as site

REPO = site.REPO


@pytest.fixture(scope="module")
def dist(tmp_path_factory):
    out = tmp_path_factory.mktemp("dist")
    report = site.build(out, base_url="https://example.test/site")
    return out, report


def test_every_answer_becomes_a_post(dist):
    out, report = dist
    answers = sorted(p.name for p in (REPO / "answers").iterdir() if (p / "answer.json").exists())
    for slug in answers:
        assert slug in report["posts"]
        assert (out / "analysis" / f"{slug}.html").exists()


def test_post_shows_the_answer_value_and_sql(dist):
    out, _ = dist
    folder = REPO / "answers" / "tracked-wallets-eth"
    answer = json.loads((folder / "answer.json").read_text())
    page = (out / "analysis" / "tracked-wallets-eth.html").read_text()
    assert answer["value"] in page
    assert answer["question"] in page
    for result in answer["results"]:
        assert result["sql"].splitlines()[0] in page
    assert answer["provenance"]["git_sha"][:12] in page


def test_facts_are_counted_from_the_repo(dist):
    _, report = dist
    facts = report["facts"]
    sources = [p for p in (REPO / "ingestion" / "sources").iterdir() if (p / "package.json").exists()]
    assert len(facts["sources"]) == len(sources)
    assert len(facts["call_sources"]) + len(facts["stream_sources"]) == len(sources)
    assert set(facts["marts"]) == {p.stem for p in (REPO / "transformation" / "models" / "marts").glob("*/*.sql")}
    schedules = (REPO / "orchestration" / "pipeline" / "schedules.py").read_text()
    assert set(facts["pipelines"]) == set(re.findall(r'^\s+"([a-z_]+)":', schedules, flags=re.M))


def test_landing_page_uses_the_counts(dist):
    out, report = dist
    page = (out / "index.html").read_text()
    facts = report["facts"]
    assert f'<span class="n">{len(facts["sources"])}</span>' in page
    assert f'<span class="n">{len(facts["marts"])}</span>' in page


def test_links_between_pages_resolve(dist):
    out, _ = dist
    for page in out.rglob("*.html"):
        text = page.read_text()
        for href in re.findall(r'(?:href|src)="([^"#]+)"', text):
            if href.startswith(("http", "mailto", "/")):
                continue
            target = (page.parent / href).resolve()
            assert target.exists(), f"{page.relative_to(out)} links to missing {href}"


def test_sitemap_and_canonicals_use_the_base_url(dist):
    out, _ = dist
    sitemap = (out / "sitemap.xml").read_text()
    assert "https://example.test/site/analysis/" in sitemap
    assert '<link rel="canonical" href="https://example.test/site/">' in (out / "index.html").read_text()


def test_display_value():
    assert site.display_value("3055.159790") == "3,055.16"
    assert site.display_value("9318316.473172448") == "9,318,316.47"
    assert site.display_value("0.803319") == "0.803319"
    assert site.display_value("22% → 32%") == "22% → 32%"
    assert site.display_value(None) == ""
