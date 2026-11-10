# 1. A software factory turns analysis tickets into pipeline PRs

Date: 2026-11-09
Status: Accepted

## Context

BlockJuice is built by one person. A new analysis arrives as a requirement in plain words, such as "the most profitable wallets on Aave last month", and becomes a pipeline: a source or two, dbt models, an analysis, a schedule. The bottleneck is hands at the keyboard, not ideas.

The repo already holds most of what an agent needs. The bj skill builds sources, marts and analyses from a question. `bj answer` checks an answer's inputs. CI runs on every PR. The triage labels exist.

The risk in letting an agent build unattended is that it grades its own work. A pipeline that runs is not a pipeline that is right.

## Decision

We run a software factory, in the sense of the software-factory skill: tasks whose runs move a ticket through a few services. Two tasks, with a human check between them.

### Slots

| Slot | Product |
|---|---|
| Ticket tracker | GitHub Issues. An "Analysis" issue form files tickets and applies the `scope` label. |
| Ticket source | The form, filled by a human. |
| Git host | GitHub. Runs act as a GitHub App installed on this repo only. |
| Orchestrator | GitHub Actions on `issues: labeled`. One concurrency group per ticket, queued, never cancelled. |
| Runner | GitHub-hosted standard runners with CI's Postgres service. The job that runs the model times out at four hours. A self-hosted runner is the escape hatch when a load outgrows them. |
| Observability platform | None. Each run uploads two artifacts: the agent transcript and `answers/<slug>/`, kept seven days. |
| Model | A Claude subscription, through a Claude Code OAuth token. Amended 2026-11-09: the plan was a Console workspace with a spend limit, but the organization's only credit is promotional and does not cover Claude Code, which is what the GitHub Action bills as. The workspace route stands as the alternative once purchased credits exist. |

### Tasks

**Scope run.** Trigger: the `scope` label, applied by the form on filing or by a human to run it again. The run removes the label as its first write, which claims the ticket. It reads the ticket, picks an eval window of a day or a few thousand blocks, and computes the reference answer from an oracle independent of SQD Portal: the protocol's own API first, then Dune, then block-pinned RPC reads. Portal MCP is the fallback, and the comment says so when it is used, since the pipeline reads Portal too and the check then covers the transformation only. The run estimates the full window's load, looks for near-duplicate tickets, and posts one comment. It writes nothing else and triggers nothing. A human re-enters by editing the ticket, replying, and relabelling.

**Build run.** Trigger: the `ready-for-agent` label, applied by a human only. The run removes the label to claim the ticket. When a `factory/<issue>-<slug>` branch exists it resumes there and reads the PR's review comments. It drives the bj skill with the ticket and the scope comment as input, loads the eval window only, and ships the reference as a seed with a dbt test. Typecheck, the package tests and `dbt parse` run before any push. After the first mismatch it makes at most three fix attempts. It opens a draft PR with the answer and the comparison table in the body. On failure the PR still opens, labelled `reference-mismatch` when the test ran and failed or `not-verified` when it produced no valid comparison, and the ticket gets `ready-for-human`. A human always merges. Nothing retries on its own, and review comments trigger nothing.

The pipeline is the deliverable, verified on the eval window: a day or a few thousand blocks, however long the ticket's window is, small enough to load through the public Portal on a shared runner in minutes. The full-window answer runs on the operator's own warehouse after the merge. Scans that do not shrink with the window, such as a factory pattern's pool discovery from a token's first pool, are the exception the scope run must estimate and name.

### The scope comment

The build run reads the scope comment by machine, so the comment has a fixed shape: a marker, prose for the human, then a fenced `yaml` block with the oracle, window, tolerance, load estimate and duplicates, and a fenced `csv` block with the reference rows. `docs/agents/factory.md` has the fields.

### Reference seeds and tests

The reference lands in `transformation/seeds/reference/reference_<name>.csv`, where `<name>` is the slug with `_` for `-`, as dbt and Postgres want it. A singular test in `transformation/tests/reference/`, tagged `reference`, compares the analysis over the eval window to the seed through the `reference_mismatches` macro, within the tolerance the scope run set. `bj answer` runs only the tests upstream of an analysis, so the build run runs these with `dbt test --select tag:reference` and records the outcome with `bj check <slug> reference_match`. CI loads the seeds and compiles the tests but never runs them, since it holds no chain data.

### Brakes

Every PR passes CI. Only a human applies the label that starts a build run. Only a human merges. Caps: three fix attempts per build run, four hours per job, and the subscription's own usage limits in place of a workspace spend limit.

### Vocabulary

The glossary's **run** stays the source's: one execution of one source. The factory's runs are the **scope run** and the **build run**, defined in the glossary's Factory section, and the bare word is never used for them.

## Consequences

- The reference outlives the run. A later change to a mart that breaks an old analysis fails the old reference test on the next pipeline run.
- The runner never holds more than the eval window, so it stays disposable and the six-hour ceiling is not a design constraint.
- Each analysis adds a seed and a test. A reference goes stale only if the window's raw rows leave the warehouse, which shows up as a failing test with an obvious cause.
- Two runs mean two round trips before any code exists. That is the price of catching a wrong definition before a pipeline is built on it.
- Tokens cost usage. On a subscription the factory's runs share the plan's limits with the operator's own sessions, so a long build run can slow interactive work. The Console's usage page is the view until a tracing platform earns its place.
- Deferred, in order of likely need: a build run triggered by a "changes requested" review, harness telemetry into the repo's Grafana, a retro task that proposes changes to the prompts.

The first ticket is one whose answer the repo already knows, so the loop is proven before it is trusted with a new protocol.
