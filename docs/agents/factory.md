# The factory

How analysis tickets become pipeline PRs without a human at the keyboard. The design is in [docs/adr/0001-software-factory.md](../adr/0001-software-factory.md). This page is the operating contract: the labels, the runs, and the files that cross between them.

## Labels

| Label | Who sets it | What happens |
|---|---|---|
| `scope` | the Analysis issue form on filing, or a human to run scope again | a scope run starts |
| `ready-for-agent` | a human, after reading the scope comment | a build run starts |
| `ready-for-human` | a build run that failed, or a human | nothing. A human reads the ticket and the draft PR |
| `reference-mismatch` | a build run, on the PR | the `reference_match` check ran and the pipeline did not match within tolerance |
| `not-verified` | a build run, on the PR | the answer holds no valid `reference_match` check: it never ran because the eval window did not load or the upstream build failed, or `bj answer --eval` wrote no new answer. The pipeline is unproven, not wrong |

A run's first write removes the label that started it. That is the claim. A second run on the same ticket queues behind the first and finds the label gone, so it exits at once.

Never add `scope` or `ready-for-agent` from inside a run. A run that needs a human ends with `ready-for-human` and a comment.

## Runs

**Scope run.** Reads the ticket. Picks an eval window of a day or a few thousand blocks. Computes the reference from an oracle independent of SQD Portal, in the order protocol API, Dune, block-pinned RPC, with Portal MCP as the declared fallback. Estimates the full window's load. Works on the eval window only and never computes the ticket's full answer, which is the build run's and the operator's work. Posts one scope comment. Writes nothing in the repo.

**Build run.** Reads the latest scope comment. Checks out `factory/<issue>-<slug>`, resuming it when it exists. Drives the bj skill to build what the analysis needs, ships the reference as `answers/<slug>/reference.csv` and a `reference` key in `question.yaml`, loads the eval window only, and runs `bj answer <slug> --eval` as its eval loop, three fix attempts at most. The eval window is a day or a few thousand blocks whatever the ticket asks for, small enough to load through the public Portal in minutes; the ticket's full window runs on the operator's warehouse after the merge. A scan that does not shrink with the window, such as pool discovery from a token's first pool, is the exception the scope comment must call out. Opens or updates a draft PR. On a failed verdict the PR gets `reference-mismatch`, or `not-verified` when the answer holds no valid check, and the ticket gets `ready-for-human`. The run never merges and never marks the PR ready for review.

Both run on GitHub Actions as the factory's GitHub App. The workflows are `.github/workflows/factory-scope.yml` and `factory-build.yml`; the prompts and glue are under `.github/factory/`.

## The scope comment

The build run reads it by machine, so its shape is fixed. It starts with `<!-- factory:scope -->`, then prose for the human, then a fenced `yaml` block and a fenced `csv` block.

The `yaml` block carries `slug`, `question`, `oracle` (`kind`, `ref`, `independent_of_portal`, `covers`), `window` (`chain`, `from`, `to`, `blocks`), `tolerance` (`kind` absolute or relative, `value`), `reference` (`key` columns, `value` column), `full_window` (`from`, `to`, `blocks`, `estimate_minutes`) and `duplicates` (issue numbers). The `csv` block is the reference table: the key columns, the value column, one row per expected result.

To change the reference, edit the ticket or reply, then add `scope` again. The newest scope comment wins.

## The reference

- File: `answers/<slug>/reference.csv`, the scope's reference rows, byte for byte. Git tracks it.
- Key: `reference` in `answers/<slug>/question.yaml`, with `analysis`, `key`, `value`, `tolerance` and `oracle` from the scope comment. The analysis returns the reference's rows over a window.
- Check: `bj answer <slug> --eval` compares the analysis's rows over the eval window with the file and records `reference_match` in the eval `answer.json`. A full run does not check it. `bj check` refuses that name.
- Verdict: the verdict step builds what the analysis reads from the committed code, deletes the model's eval `answer.json`, runs `bj answer <slug> --eval` and reads `reference_match` from the new file. A stale or missing answer, a missing check or a failed upstream build is `not-verified`.
- CI builds no reference: the check needs chain data, and CI holds none.

## What a human does

1. File an Analysis ticket through the form. Say why you want it and what counts.
2. Read the scope comment. Check the oracle, the window and the definitions. Edit and relabel `scope` until it is right.
3. Add `ready-for-agent`.
4. Review the draft PR. To have the agent address review comments, comment on the ticket and add `ready-for-agent` again. To fix by hand, push to the branch.
5. Merge. Run the full window on your own warehouse with `bj answer`.

## Secrets and setup

Repository secrets: `FACTORY_APP_CLIENT_ID`, `FACTORY_APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `DUNE_API_KEY`, `EVM_RPC_URL`, `PORTAL_API_KEY`, and `PORTAL_HOST` when the build run should read a Portal other than the public one. The App is installed on this repo only, with issues, pull requests and contents read and write, and metadata read. `.github/factory/README.md` has the dry-run procedure.
