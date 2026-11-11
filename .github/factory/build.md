# Build run

You build the pipeline one analysis ticket needs, in this checkout of BlockJuice, and prove it on a short eval window against a reference answer. A human scoped the ticket and added `ready-for-agent`: that is the go the bj skill asks for, so do not stop to ask. Workflow steps after you run the reference test again as the verdict, run the repo's checks, commit your changes, push them and open a draft PR. You write files only.

## Read first

1. `.factory/issue.md`: the ticket and its comments in order. When it has a "Review of PR" section, this checkout is the PR's branch with the earlier run's work on it. Address each review comment, and say how in `result.md`.
2. `.factory/scope.yaml` and `.factory/reference.csv`: the scope the human approved. The slug, the eval window, the oracle, the tolerance and the reference rows come from here. `docs/agents/factory.md` explains the fields.
3. `.claude/skills/blockjuice/SKILL.md` and the workflows it routes to, starting with `workflows/answer.md`.
4. `GLOSSARY.md`. Use its words.
5. `transformation/seeds/reference/README.md`: the reference seed and test, with an example.

The section "This run" at the end gives the ticket number, the slug, `<name>` (the slug with `_` for `-`) and the branch.

## The warehouse

A Postgres on this runner, empty apart from the run log tables. The environment already holds the warehouse settings from `.env.example`, and `bj install` has written every `.env`. Run dbt as `cd transformation && uv run --project ../orchestration dbt <args>`, or with the skill's `set -a && . ./.env && set +a &&` prefix. `psql` connects with no arguments.

Load the eval window only, never the ticket's full window, however long the ticket's window is. The runner reads the public Portal, which paces anonymous streams, and the operator runs the full window on their own warehouse after the merge. A stream source reads from `START_BLOCK` to `END_BLOCK` in its `chains/<chain>/.env`, which git ignores: set both to `window.blocks`. A source with no `END_BLOCK` yet gets one, as `evm-chainlink-price-feeds` has.

A scan that does not shrink with the window, such as a factory pattern's pool discovery from a token's first pool, is the exception. Before you run one in full, run it with a timeout of a few minutes and estimate it from how far it got. If it would not finish well inside this run, leave it, and write `result.md` with the scan's size, the rate you saw, and the two ways out: a `PORTAL_API_KEY` for the factory, or a way for the source to take the eval's contracts directly. Never widen the eval window or shrink the scan to make a load fit: a pool left out is a mismatch the test would hide.

## One turn

This run is one turn, and nobody reads your messages. When you end the turn the run ends, and the workflow steps take what the checkout holds. Nothing wakes you later.

- Run every command in the foreground and wait for it. Never start a background job, schedule a wakeup or set a monitor.
- Give a load a timeout that covers it, up to 60 minutes. The runner ends a command that runs longer.
- Never end the turn with work you mean to come back to. `.factory/result.md` must exist before you end the turn. When the build is unfinished, it says what is left.

## Do

1. Write `transformation/seeds/reference/reference_<name>.csv` with the exact contents of `.factory/reference.csv`. Register it in `transformation/seeds/reference/_reference_seeds.yml` with a description that names the oracle (`oracle.kind` and `oracle.ref`), the window (chain, blocks and times) and the ticket number. Give key columns that hold addresses `text` in `column_types`.
2. Write `transformation/tests/reference/<name>_matches_reference.sql`, tagged `reference`, as the README's example shows. Its `actual` CTE is the analysis SQL restricted to `window.blocks`. Pass `reference.key`, `reference.value`, `tolerance.kind` and `tolerance.value` from `scope.yaml` to `reference_mismatches`.
3. Follow the bj skill's answer workflow to build what is missing: sources, marts, the analysis. Write `answers/<slug>/question.yaml` with the ticket's question and the scope's window, then `answers/<slug>/answer.md` as the workflow says.
4. Run the eval loop:
   - `uv run --project orchestration bj answer <slug>`
   - `cd transformation && uv run --project ../orchestration dbt seed --select reference_<name>`
   - `cd transformation && uv run --project ../orchestration dbt test --select tag:reference,<name>_matches_reference`
5. When the test fails, find why, fix it and run the loop again. You get three fix attempts after the first mismatch. Then stop, even if it still fails. Never change the reference rows or widen the tolerance to make it pass: the reference is the human's, and a mismatch you cannot fix is a finding.
6. Run `pnpm typecheck` in `ingestion/` and fix what it reports. The workflow runs it again after you, and CI runs it on the PR.
7. Write `.factory/result.md`, the PR body, with these sections:
   - **What was built**: each file you added or changed, one line each.
   - **Answer**: the answer in one sentence, from `answer.md`.
   - **Comparison**: one row per reference row with the key, expected, got, and the tolerance. Get "got" by joining the seed to the `actual` CTE of the compiled test (`transformation/target/compiled/transformation/tests/reference/<name>_matches_reference.sql`), through `psql` or `dbt show --inline`. With more than 50 rows, show every mismatch and the first rows.
   - **Verified window**: chain, blocks and times.
   - **Full window**: `full_window` from `scope.yaml`, with the load estimate.
   - **For the reviewer**: what to check, including each fix attempt you made and anything you could not finish.

## Never

- Commit, push, or run git or gh. The workflow does every write to GitHub.
- Edit `.github/`, `.factory/scope.yaml` or `.factory/reference.csv`.
- Answer from memory.

## Stop

Stop when the reference test passes and `result.md` is written. Stop too after the third fix attempt, or when a blocker needs a human: an address the ticket does not resolve, a source that cannot load the window. Then write `result.md` with what you built, what failed and what the human must decide.
