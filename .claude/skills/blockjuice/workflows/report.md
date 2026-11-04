# Report an answer

```sh
uv run --project orchestration bj report <slug> --format xlsx,pdf
```

It writes `answers/<slug>/reports/<slug>.xlsx` and `answers/<slug>/reports/<slug>.pdf` from `answer.json`, `answer.md` and `results/`. Ask for one format with `--format xlsx` or `--format pdf`.

- To change a number or a sentence, fix `answer.md` or rerun `bj answer`, then rerun `bj report`. Never edit a report file by hand.
- Open the PDF with the Read tool and check it before you hand it over.
- Git ignores `reports/`, since `bj report` rebuilds it. Give the user the file paths.

Google Docs reports are not built yet.
