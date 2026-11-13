# The factory

How analysis tickets become pipeline PRs without a human at the keyboard. The design is in [docs/adr/0001-software-factory.md](../adr/0001-software-factory.md). This page is the operating contract: the labels, the runs, and the files that cross between them.

## Labels

| Label | Who sets it | What happens |
|---|---|---|
| `scope` | the Analysis issue form on filing, or a human to run scope again | a scope run starts |
| `ready-for-agent` | a human, after reading the scope comment | a build run starts |
| `ready-for-human` | a build run that failed, or a human | nothing. A human reads the ticket and the draft PR |
| `reference-mismatch` | a build run, on the PR | the reference test ran and the pipeline did not match within tolerance |
| `not-verified` | a build run, on the PR | the reference test produced no valid comparison: it never ran because the eval window did not load or the upstream build failed, or it ended in an error. The pipeline is unproven, not wrong |

A run's first write removes the label that started it. That is the claim. A second run on the same ticket queues behind the first and finds the label gone, so it exits at once.

Never add `scope` or `ready-for-agent` from inside a run. A run that needs a human ends with `ready-for-human` and a comment.

## Runs

**Scope run.** Reads the ticket. Picks an eval window of a day or a few thousand blocks. Computes the reference from an oracle independent of SQD Portal, in the order protocol API, Dune, block-pinned RPC, with Portal MCP as the declared fallback. Estimates the full window's load. Works on the eval window only and never computes the ticket's full answer, which is the build run's and the operator's work. Posts one scope comment. Writes nothing in the repo.

**Build run.** Reads the latest scope comment. Checks out `factory/<issue>-<slug>`, resuming it when it exists. Drives the bj skill to build what the analysis needs, ships the reference as a seed and a test, loads the eval window only, and runs the test as its eval loop, three fix attempts at most. The eval window is a day or a few thousand blocks whatever the ticket asks for, small enough to load through the public Portal in minutes; the ticket's full window runs on the operator's warehouse after the merge. A scan that does not shrink with the window, such as pool discovery from a token's first pool, is the exception the scope comment must call out. Opens or updates a draft PR. On a failed verdict the PR gets `reference-mismatch`, or `not-verified` when the test produced no valid comparison, and the ticket gets `ready-for-human`. The run never merges and never marks the PR ready for review.

Both run on GitHub Actions as the factory's GitHub App. The workflows are `.github/workflows/factory-scope.yml` and `factory-build.yml`; the prompts and glue are under `.github/factory/`.

## The scope comment

The build run reads it by machine, so its shape is fixed. It starts with `<!-- factory:scope -->`, then prose for the human, then a fenced `yaml` block and a fenced `csv` block.

The `yaml` block carries `slug`, `question`, `oracle` (`kind`, `ref`, `independent_of_portal`, `covers`), `window` (`chain`, `from`, `to`, `blocks`), `tolerance` (`kind` absolute or relative, `value`), `reference` (`key` columns, `value` column), `full_window` (`from`, `to`, `blocks`, `estimate_minutes`) and `duplicates` (issue numbers). The `csv` block is the reference table: the key columns, the value column, one row per expected result.

To change the reference, edit the ticket or reply, then add `scope` again. The newest scope comment wins.

## Reference seeds and tests

- Seed: `transformation/seeds/reference/reference_<name>.csv`, where `<name>` is the slug with `_` for `-`. Registered in `_reference_seeds.yml` with a description naming the oracle, the window and the ticket.
- Test: `transformation/tests/reference/<name>_matches_reference.sql`, tagged `reference`, built on the `reference_mismatches` macro.
- `bj answer` does not run these tests. Run them with `dbt test --select tag:reference`. The build run records the verdict in the evaluation answer with `bj check <slug> --eval reference_match`.
- CI seeds and compiles them but never runs them.

## What a human does

1. File an Analysis ticket through the form. Say why you want it and what counts.
2. Read the scope comment. Check the oracle, the window and the definitions. Edit and relabel `scope` until it is right.
3. Add `ready-for-agent`.
4. Review the draft PR. To have the agent address review comments, comment on the ticket and add `ready-for-agent` again. To fix by hand, push to the branch.
5. Merge. Run the full window on your own warehouse with `bj answer`.

## Secrets and setup

Repository secrets: `FACTORY_APP_CLIENT_ID`, `FACTORY_APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `DUNE_API_KEY`, `EVM_RPC_URL`, `PORTAL_API_KEY`, and `PORTAL_HOST` when the build run should read a Portal other than the public one. The App is installed on this repo only, with issues, pull requests and contents read and write, and metadata read. `.github/factory/README.md` has the dry-run procedure.
