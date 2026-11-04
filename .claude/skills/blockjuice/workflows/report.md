# Report an answer

```sh
uv run --project orchestration bj report <slug> --format xlsx,pdf
```

It builds each format from `answer.json`, `answer.md` and `results/`. `--format` takes any of `xlsx`, `pdf`, `docx` and `gdoc`, comma-separated, and defaults to `xlsx,pdf`. Files land in `answers/<slug>/reports/<slug>.<format>`.

- To change a number or a sentence, fix `answer.md` or rerun `bj answer`, then rerun `bj report`. Never edit a report file by hand.
- Open the PDF with the Read tool and check it before you hand it over.
- Git ignores `reports/`, since `bj report` rebuilds it. Give the user the file paths.

## Google Docs

`--format gdoc` uploads the report to the user's Google Drive as a Google Doc and prints its URL. A rerun updates the same Doc, whose id `reports/<slug>.gdoc.json` keeps.

It needs Google credentials in `.env`. When `bj` exits 2 asking for them, pass its message to the user. They create a Desktop OAuth client in a Google Cloud project with the Drive API on, and set `GOOGLE_OAUTH_CLIENT_SECRET` to its JSON file. The first run opens a browser for their consent, so the user runs that one themselves. `GOOGLE_DRIVE_FOLDER_ID` puts new Docs in a folder.
