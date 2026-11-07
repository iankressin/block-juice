# Prototype 1: Juice label

A static prototype of the public site in the banner's retro juice-label style: cream paper, plum ink, mustard and orange accents, chunky display type. Three sections:

| Page | What it is |
|---|---|
| `index.html` | Landing page: why, what ships, how it runs, quick start, latest posts |
| `analysis/` | Market analysis posts. Each post is an answer folder (`answers/<slug>/`) turned into a page: the value, how it was counted, charts, provenance from the run log, caveats and the SQL to rerun it |
| `changelog/` | What changed, by day, with a link to each pull request |

No build step. Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server --directory website/01-juice-label 8080
```

Fonts load from Google Fonts; everything else is in `assets/`: the stylesheet, the banner, and the logo and mascot cut out of it (`logo.png`, `mascot.png`). The site has one light look and no dark mode.

## Posts

The two tracked-wallets posts use the real figures from `answers/tracked-wallets-eth/` and `answers/tracked-wallets-sol/`. The UNI post is a sample that shows the format of a market post built from the `dex` and `prices` pipelines; its figures are placeholders and the page says so.

The intended flow is `bj answer <slug>` writes `answers/<slug>/`, and a generator turns `answer.json`, `answer.md` and `results/*.csv` into `analysis/<slug>.html`. The generator is not written yet; the pages here are hand-built to the shape it would produce.
