# BlockJuice website prototypes

Three static prototypes of the public site. Each one has the same three sections and the same content, in a different design direction:

| Folder | Direction | Feel |
|---|---|---|
| [`01-juice-label/`](01-juice-label/) | Juice label | The banner's retro print look: cream paper, plum ink, mustard and orange, chunky display type, rounded cards with hard shadows |
| [`02-console/`](02-console/) | Console | A warehouse operator's console, dark first: graphite ground, amber accent, monospace for anything from the warehouse, flat panels, a left rail nav, a terminal transcript as the hero |
| [`03-research-desk/`](03-research-desk/) | Research desk | A quiet research publication: paper white, ink navy, one teal accent, serif display, a text column with margin notes for definitions and provenance |

Every prototype has:

- a **landing page** (`index.html`): why, what ships, how it runs, quick start, latest posts
- an **analysis section** (`analysis/`): posts built from answer folders (`answers/<slug>/`), each with the value, how it was counted, charts, provenance from the run log, caveats and the SQL to rerun it. Two posts use the real figures from `answers/tracked-wallets-eth/` and `answers/tracked-wallets-sol/`. The UNI post is a sample that shows the format of a market post from the `dex` and `prices` pipelines; its figures are placeholders and the page says so
- a **changelog** (`changelog/`): what changed by day, with a link to each pull request

No build step. `index.html` at this level links to all three, or serve one directly:

```sh
python3 -m http.server --directory website 8080
# then open http://localhost:8080/
```

Fonts load from Google Fonts; everything else is in each prototype's `assets/`.

The intended flow for posts is `bj answer <slug>` writes `answers/<slug>/`, and a generator turns `answer.json`, `answer.md` and `results/*.csv` into `analysis/<slug>.html`. The generator is not written yet; the pages are hand-built to the shape it would produce.
