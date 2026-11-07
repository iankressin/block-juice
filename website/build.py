"""Build the BlockJuice website.

    uv run --project website website/build.py [--out DIR] [--base-url URL]

Reads the repo for the landing page facts, `answers/<slug>/` for analysis
posts, `website/content/` for hand-written posts and the changelog, and
renders everything with the templates in `website/templates/` into
`website/dist/`. Static files are copied as they are.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import html
import json
import re
import shutil
import sys
from pathlib import Path

import markdown
import yaml
from jinja2 import Environment, FileSystemLoader, select_autoescape

HERE = Path(__file__).resolve().parent
REPO = next(p for p in [HERE, *HERE.parents] if (p / "ingestion" / "sources").is_dir())
CONTENT = HERE / "content"
TEMPLATES = HERE / "templates"
STATIC = HERE / "static"
ANSWERS = REPO / "answers"

MAX_BAR_ROWS = 12


# --- facts from the repo ----------------------------------------------------

def repo_facts(repo: Path = REPO) -> dict:
    """Counts the landing page shows, read from the repo so they cannot drift."""
    sources_dir = repo / "ingestion" / "sources"
    sources = sorted(p for p in sources_dir.iterdir() if p.is_dir() and (p / "package.json").exists())
    stream, call, chains = [], [], set()
    for src in sources:
        deps = json.loads((src / "package.json").read_text()).get("dependencies", {})
        (stream if "@subsquid/pipes" in deps else call).append(src.name)
        chains_dir = src / "chains"
        if chains_dir.is_dir():
            chains.update(p.name for p in chains_dir.iterdir() if p.is_dir())
        else:
            prefix = src.name.split("-")[0]
            if prefix in ("solana", "bitcoin"):
                chains.add(prefix)
    schedules = (repo / "orchestration" / "pipeline" / "schedules.py").read_text()
    pipelines = dict(re.findall(r'"([a-z_]+)":\s*"([^"]+)"', schedules.split("PIPELINES", 1)[1].split("}", 1)[0]))
    crons = set(pipelines.values())
    schedule = "daily at %s UTC" % cron_time(next(iter(crons))) if len(crons) == 1 else "%d schedules" % len(crons)
    marts = sorted(p.stem for p in (repo / "transformation" / "models" / "marts").glob("*/*.sql"))
    protocols = sorted(p.name for p in (repo / "catalog" / "protocols").iterdir() if p.is_dir())
    chain_order = ["ethereum", "arbitrum", "base", "optimism", "solana", "bitcoin"]
    return {
        "chains": sorted(chains, key=lambda c: (chain_order.index(c) if c in chain_order else 99, c)),
        "sources": [s.name for s in sources],
        "call_sources": call,
        "stream_sources": stream,
        "pipelines": pipelines,
        "schedule": schedule,
        "marts": marts,
        "protocols": protocols,
    }


def cron_time(cron: str) -> str:
    minute, hour = cron.split()[:2]
    return "%02d:%02d" % (int(hour), int(minute)) if hour.isdigit() and minute.isdigit() else cron


# --- posts -------------------------------------------------------------------

def load_answer_posts(answers: Path = ANSWERS) -> list[dict]:
    posts = []
    for folder in sorted(answers.iterdir()) if answers.is_dir() else []:
        if (folder / "answer.json").exists():
            posts.append(answer_post(folder))
    return posts


def answer_post(folder: Path) -> dict:
    answer = json.loads((folder / "answer.json").read_text())
    question = yaml.safe_load((folder / "question.yaml").read_text()) if (folder / "question.yaml").exists() else {}
    body_md = (folder / "answer.md").read_text() if (folder / "answer.md").exists() else ""
    lede_md, rest_md = split_lede(body_md)
    results = [result_view(folder, r) for r in answer.get("results", [])]
    unit = unit_of(answer, results)
    window = answer.get("window", {})
    chain = window.get("chain")
    return {
        "slug": answer["slug"],
        "title": answer["question"],
        "date": answer.get("answered_at", "")[:10],
        "answered_at": answer.get("answered_at", ""),
        "asked": str(question.get("asked", "")),
        "sample": False,
        "chains": [chain] if chain else [],
        "marts": question.get("marts") or sorted({i.get("mart") for i in question.get("inputs", []) if i.get("mart")}),
        "value": answer.get("value"),
        "value_display": display_value(answer.get("value")),
        "unit": unit,
        "window": window_text(window),
        "summary": md_inline(lede_md),
        "body_html": md(rest_md),
        "results": results,
        "charts": [r["chart"] for r in results if r.get("chart")],
        "checks": answer.get("checks", []),
        "inputs": answer.get("inputs", []),
        "provenance": answer.get("provenance", {}),
        "question_yaml": (folder / "question.yaml").read_text() if (folder / "question.yaml").exists() else "",
        "source_dir": "answers/%s/" % answer["slug"],
        "href": "analysis/%s.html" % answer["slug"],
    }


def load_content_posts(content: Path = CONTENT) -> list[dict]:
    """Hand-written posts: content/posts/<slug>/post.yaml plus body.html."""
    posts = []
    for folder in sorted((content / "posts").iterdir()) if (content / "posts").is_dir() else []:
        meta_path = folder / "post.yaml"
        if not meta_path.exists():
            continue
        meta = yaml.safe_load(meta_path.read_text())
        post = {
            "slug": folder.name,
            "title": meta["title"],
            "date": str(meta["date"]),
            "answered_at": "",
            "asked": "",
            "sample": bool(meta.get("sample", False)),
            "chains": meta.get("chains", []),
            "marts": meta.get("marts", []),
            "value": meta.get("value"),
            "value_display": meta.get("value"),
            "unit": meta.get("unit", ""),
            "window": meta.get("window", ""),
            "summary": meta.get("summary", ""),
            "body_html": (folder / "body.html").read_text() if (folder / "body.html").exists() else "",
            "results": [],
            "charts": [],
            "checks": [],
            "inputs": [],
            "provenance": {},
            "question_yaml": "",
            "source_dir": "website/content/posts/%s/" % folder.name,
            "href": "analysis/%s.html" % folder.name,
        }
        posts.append(post)
    return posts


def split_lede(body_md: str) -> tuple[str, str]:
    """The first paragraph of answer.md is the one-line answer; the rest is the method."""
    parts = re.split(r"\n\s*\n", body_md.strip(), maxsplit=1)
    if len(parts) == 1:
        return (parts[0], "") if not parts[0].startswith("#") else ("", parts[0])
    return parts[0], parts[1]


def result_view(folder: Path, result: dict) -> dict:
    path = folder / result["path"]
    rows: list[dict] = []
    if path.exists():
        with path.open(newline="") as f:
            rows = list(csv.DictReader(f))
    columns = result.get("columns") or (list(rows[0].keys()) if rows else [])
    view = {
        "analysis": result["analysis"],
        "path": result["path"],
        "columns": columns,
        "rows": rows,
        "numeric": {c: all(is_number(r.get(c, "")) for r in rows) for c in columns} if rows else {},
        "sql": result.get("sql", ""),
    }
    view["chart"] = bar_chart(view)
    return view


def bar_chart(view: dict) -> dict | None:
    """One horizontal bar per row, for a small result with a label and a number."""
    rows, columns, numeric = view["rows"], view["columns"], view["numeric"]
    if not 2 <= len(rows) <= MAX_BAR_ROWS:
        return None
    labels = [c for c in columns if not numeric.get(c)]
    numbers = [c for c in columns if numeric.get(c) and not c.endswith("_number") and c not in ("block_number", "slot")]
    if not labels or not numbers:
        return None
    label_col = labels[0]
    # prefer a column that is not an integer base unit (wei, lamports) when a scaled one exists
    scaled = [c for c in numbers if any("." in r[c] for r in rows)]
    value_col = scaled[0] if scaled else numbers[0]
    values = [float(r[value_col]) for r in rows]
    top = max(values) or 1.0
    bars = [
        {"label": short_id(r[label_col]), "full": r[label_col], "value": r[value_col], "display": display_value(r[value_col]), "pct": max(0.4, v / top * 100)}
        for r, v in zip(rows, values)
    ]
    return {"title": "%s per %s" % (value_col.upper() if len(value_col) <= 4 else value_col.replace("_", " "), label_col), "value_col": value_col, "label_col": label_col, "bars": bars, "top": display_value(str(top))}


def unit_of(answer: dict, results: list[dict]) -> str:
    if results and results[0]["columns"] and results[0]["rows"]:
        first = results[0]["columns"][0]
        if results[0]["rows"][0].get(first) == answer.get("value") and len(first) <= 5:
            return first.upper()
    return ""


def window_text(window: dict) -> str:
    chain = window.get("chain", "")
    if window.get("at"):
        return "%s, at %s" % (chain, window["at"])
    if window.get("from_block") or window.get("to_block"):
        return "%s, blocks %s to %s" % (chain, window.get("from_block", "?"), window.get("to_block", "?"))
    return chain


# --- formatting ---------------------------------------------------------------

_md = markdown.Markdown(extensions=["tables", "fenced_code"])


def md(text: str) -> str:
    """Markdown to HTML, with every table inside a scrolling wrapper."""
    _md.reset()
    out = _md.convert(text)
    return out.replace("<table>", '<div class="table-wrap"><table>').replace("</table>", "</table></div>")


def md_inline(text: str) -> str:
    out = md(text)
    return re.sub(r"^<p>(.*)</p>$", r"\1", out.strip(), flags=re.S)


def is_number(s: str) -> bool:
    try:
        float(s)
        return True
    except (TypeError, ValueError):
        return False


def display_value(value) -> str:
    """3055.159790 -> 3,055.16; 9318316.473172448 -> 9,318,316.47; 22% stays."""
    if value is None:
        return ""
    s = str(value)
    if not is_number(s):
        return s
    f = float(s)
    if abs(f) >= 1000:
        return "{:,.2f}".format(f)
    if "." in s:
        return "{:,.2f}".format(f) if abs(f) >= 1 else s
    return "{:,}".format(int(f))


def short_id(s: str) -> str:
    return s if len(s) <= 14 else "%s…%s" % (s[:6], s[-4:])


# --- changelog ----------------------------------------------------------------

def load_changelog(content: Path = CONTENT) -> list[dict]:
    releases = yaml.safe_load((content / "changelog.yaml").read_text())
    for r in releases:
        r["date"] = str(r.get("date") or "")
        r["label"] = r.get("label") or ("%d pull requests" % len(r["entries"]) if r["date"] else "")
    return releases


# --- build --------------------------------------------------------------------

def build(out: Path, base_url: str | None = None, answers: Path = ANSWERS, repo: Path = REPO) -> dict:
    site = yaml.safe_load((HERE / "site.yaml").read_text())
    if base_url:
        site["base_url"] = base_url
    site["base_url"] = site["base_url"].rstrip("/")
    facts = repo_facts(repo)
    missing = [m for row in site["ships"] for m in row["marts"] if m not in facts["marts"]]
    if missing:
        raise SystemExit("site.yaml lists marts that do not exist: %s" % ", ".join(missing))
    posts = sorted(load_answer_posts(answers) + load_content_posts(), key=lambda p: p["date"], reverse=True)
    changelog = load_changelog()
    env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape(["html"]), trim_blocks=True, lstrip_blocks=True)
    env.filters["display_value"] = display_value
    built_at = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    common = {"site": site, "facts": facts, "posts": posts, "changelog": changelog, "built_at": built_at}

    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(STATIC, out / "static")
    pages = {
        "index.html": ("index.html", {"depth": 0, "current": "index.html"}),
        "analysis/index.html": ("analysis.html", {"depth": 1, "current": "analysis/index.html"}),
        "changelog/index.html": ("changelog.html", {"depth": 1, "current": "changelog/index.html"}),
        "404.html": ("404.html", {"depth": 0, "current": ""}),
    }
    for post in posts:
        pages[post["href"]] = ("post.html", {"depth": 1, "current": "analysis/index.html", "post": post})
    for path, (template, ctx) in pages.items():
        target = out / path
        target.parent.mkdir(parents=True, exist_ok=True)
        ctx = {**common, **ctx, "root": "../" * ctx["depth"], "path": path}
        target.write_text(env.get_template(template).render(**ctx))
    (out / "robots.txt").write_text("User-agent: *\nAllow: /\nSitemap: %s/sitemap.xml\n" % site["base_url"])
    urls = [p for p in pages if p != "404.html"]
    (out / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join("  <url><loc>%s/%s</loc></url>\n" % (site["base_url"], html.escape(u.replace("index.html", ""))) for u in urls)
        + "</urlset>\n"
    )
    return {"pages": sorted(pages), "posts": [p["slug"] for p in posts], "facts": facts}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=HERE / "dist")
    parser.add_argument("--base-url", default=None)
    args = parser.parse_args(argv)
    report = build(args.out, args.base_url)
    f = report["facts"]
    print("built %d pages into %s" % (len(report["pages"]), args.out))
    print("posts: %s" % ", ".join(report["posts"]))
    print("facts: %d chains, %d sources (%d call, %d stream), %d pipelines, %d marts, %d protocols" % (
        len(f["chains"]), len(f["sources"]), len(f["call_sources"]), len(f["stream_sources"]), len(f["pipelines"]), len(f["marts"]), len(f["protocols"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
