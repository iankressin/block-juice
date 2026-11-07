# BlockJuice website

The public site: a landing page, analysis posts and a changelog, built from this repo. The look is the banner's: cream paper, plum ink, mustard and orange, the mascot and the hand lettering cut out of `docs/images/bj-banner-2.png`.

## Build

```sh
uv run --project website website/build.py          # writes website/dist/
python3 -m http.server --directory website/dist 8080
uv run --project website pytest -q website/tests   # checks the build against the repo
```

`uv run` installs the three dependencies (Jinja2, Markdown, PyYAML) the first time. `--base-url` sets the canonical and sitemap URLs; `site.yaml` holds the default. `.github/workflows/website.yml` builds and deploys `dist/` to GitHub Pages on every push to `main` that touches the site or what it reads. Enable Pages once under Settings → Pages → Source: GitHub Actions.

## Where the content comes from

| Page | Source |
|---|---|
| Landing page | Copy in `templates/index.html`. The Contents panel and the pipeline list are counted from the repo at build time: chains and sources from `ingestion/sources/`, pipelines from `orchestration/pipeline/schedules.py`, marts from `transformation/models/marts/`, protocols from `catalog/protocols/`. The marts table is `ships` in `site.yaml`, and the build fails if it names a mart that does not exist |
| Analysis posts | One per `answers/<slug>/` with an `answer.json`. The title is the question, the headline number is `value`, the first paragraph of `answer.md` is the summary and the rest is the body. A result with a label column and a number column (up to 12 rows) gets a bar chart. Checks, inputs, provenance and the SQL of each analysis come from `answer.json`; `question.yaml` is attached as is |
| Hand-written posts | `content/posts/<slug>/post.yaml` plus `body.html`, for a post that is not an answer folder yet. `sample: true` labels it as placeholder figures. `uni-dex-venues` is one; delete the folder once a real answer covers the question |
| Changelog | `content/changelog.yaml`, newest first. Each entry has a kind (added, changed, fixed, docs), HTML text and a pull request number. A release without a date is the roadmap |

To publish a new post, ask the question with `/bj` so `bj answer` writes `answers/<slug>/`, commit the folder, and push. The workflow rebuilds the site.

## Layout

```
website/
├── build.py            # the generator
├── site.yaml           # name, URLs, nav, the marts table
├── templates/          # Jinja2: base, index, analysis, post, changelog, 404
├── static/             # site.css, logo.png, mascot.png, favicon, og.png, sample-charts.js
├── content/            # changelog.yaml, posts/<slug>/
├── tests/              # pytest: the build matches the repo
└── dist/               # output, not committed
```
