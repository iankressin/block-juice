# BlockJuice

**A self-hosted ELT framework and warehouse for blockchain data you can trust — and rerun.**

If you advise funds, treasuries, or protocol teams, you already know the awkward middle of on-chain work: explorers are great for a screenshot, shared analytics platforms are great until the query, the join, or the retention policy isn’t yours. BlockJuice is the other path. It runs in **your** environment, loads chain data into **your** Postgres, transforms it with dbt, and schedules the work with Dagster — so balances, transfers, trades, and labels live next to the rest of your stack, under keys and policies you control.

The point isn’t another indexer to babysit. It’s a readable pipeline a consultant can stand up, extend, and hand to a client without apologizing for a black box.

## Why this makes life easier

**You keep the data.** Raw rows, marts, run logs, and answer artifacts stay in the warehouse and repo you operate. No “export from the SaaS” step when diligence asks how a number was built.

**You ask in plain language, get a checked answer.** Open the repo in Claude Code and use `/bj <question>`. The skill maps the question onto marts (or builds what’s missing), runs analyses through the `bj` CLI, writes `answers/<slug>/` with the value, checks, and method — then optional PDF, spreadsheet, or Google Doc. The path from question → warehouse → shareable report is the product UX, not a side script.

**You extend without inventing a platform.** Need another wallet list, another EVM chain, another protocol? Copy a source with `bj new-source`, regenerate `sources.json`, follow the chain-add pattern in dbt, schedule a pipeline. Call sources and stream sources are named in the [glossary](GLOSSARY.md); dead letters and cursors are already in the shared library. The framework absorbs the boring glue so you spend time on the question.

**You can see when it broke.** `bj doctor` checks env and infra before you debug in the dark. Grafana and the `ops.*` run log show ingestion and dbt together. Failed calls park as dead letters instead of silently vanishing.

## What you get

| You care about | What ships |
|---|---|
| Point-in-time balances | ETH, ERC-20, SOL, SPL, BTC → `analytics.latest_balances` |
| Transfer history | ERC-20 on Ethereum, Arbitrum, Base → `analytics.erc20_transfers` |
| DEX activity | Uniswap v2/v3/v4 → `analytics.dex_trades` |
| Address labels | Code + exchange seeds → `analytics.address_labels` |
| How it runs | TypeScript extract/load → dbt → Dagster, plus Docker for warehouse, eRPC, Dshackle, and monitoring |
| How you drive it | `bj` CLI (`doctor`, `run`, `answer`, `report`, `new-source`, …) and the blockjuice skill |

Under the hood it’s ordinary software engineering for data: typed sources, tests, schedules, and docs a teammate can follow. Details live in [docs/architecture.md](docs/architecture.md).

## Quick start

Needs Node 24 and [pnpm](https://pnpm.io) (pinned in `mise.toml`), [uv](https://docs.astral.sh/uv/), and Docker.

```sh
cp .env.example .env
docker compose up -d
(cd ingestion && pnpm install)
(cd orchestration && uv sync)
uv run --project orchestration bj doctor
set -a && source .env && set +a
cd orchestration && uv run dagster dev
```

Open http://localhost:3000, materialize what you need, then ask a question with `/bj` or follow [Ask a question](docs/architecture.md#ask-a-question). If something’s off, start with `bj doctor` — not a scavenger hunt through five `.env` files.

## A day with BlockJuice

1. **Stand up the stack** once (`docker compose`, `bj doctor`, Dagster UI).
2. **Point sources at the wallets and tokens that matter** (`addresses.json`, chain folders for multi-chain packages).
3. **Materialize a pipeline** (balances, transfers, dex, labels) on a schedule you own.
4. **Ask the business question** in Claude Code; get an answer folder with checks and an optional report.
5. **When the brief changes**, add a source or a chain — don’t rebuild extraction from scratch.

That’s the UX bar: a consultant should feel oriented in an afternoon, not after a week of folklore.

## Docs

| Doc | When you need it |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Layout, data flow, CLI reference, monitoring, adding sources and pipelines |
| [GLOSSARY.md](GLOSSARY.md) | Shared language: source, stream source, call, record, batch, run, dead letter |
| [transformation/README.md](transformation/README.md) | dbt models and adding a chain to balances |
| `.claude/skills/blockjuice/` | Question → mart → answer → report workflows |

## Status

BlockJuice is under active development. Today the framework **is** this repository: clone it, configure `.env`, own the warehouse. We’re designing thinner packaging for customer apps; the contracts consultants touch (`name`/`table`, mart shapes, `bj`) are meant to stay stable as that lands.
