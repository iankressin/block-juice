# BlockJuice

An open ELT framework for blockchain data you run yourself.

BlockJuice loads on-chain state and history into **your** warehouse, transforms it with dbt, and orchestrates the work with Dagster. Answers and reports come from those tables — not from a hosted explorer or a shared SaaS dataset — so consultants and analysts keep data sovereignty and a path they can rerun.

## What you get

| Stage | Tool | Folder |
|-----------|------------|-------------------|
| Extract + load | TypeScript sources | `ingestion/` |
| Transform | dbt | `transformation/` |
| Orchestrate | Dagster + `bj` CLI | `orchestration/` |

Infra (Postgres warehouse, eRPC, Dshackle, Grafana/Prometheus) starts with Docker Compose. A Claude Code skill (`.claude/skills/blockjuice/`) turns a question into warehouse work, checks, and optional PDF/spreadsheet/Google Doc reports.

**Marts today:** `analytics.latest_balances` (ETH, ERC-20, SOL, SPL, BTC), `analytics.erc20_transfers` (Ethereum, Arbitrum, Base), `analytics.dex_trades` (Uniswap v2/v3/v4), `analytics.address_labels`.

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

Open http://localhost:3000 and materialize the assets you need. Details, per-layer commands, and troubleshooting live in [docs/architecture.md](docs/architecture.md).

## Extend it

- **New source** — `bj new-source <source> <table> --like <package>`, then staging + regenerate `ingestion/sources.json`. Call sources vs stream sources, dead letters, and multi-chain `evm-*` packages: [architecture — Add a source](docs/architecture.md#add-a-source).
- **New chain on balances** — [transformation/README.md](transformation/README.md) `## Adding a chain`.
- **New pipeline / schedule** — mart models + `PIPELINES` in `orchestration/pipeline/schedules.py`: [architecture — Add a pipeline](docs/architecture.md#add-a-pipeline).
- **Ask a question** — open the repo in Claude Code and use `/bj <question>`, or follow the skill workflows. Mechanical steps go through the `bj` CLI (`bj answer`, `bj report`, …).

Use the words in [GLOSSARY.md](GLOSSARY.md).

## Docs

| Doc | What it’s for |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Layout, data flow, CLI, monitoring, logging, extending sources and pipelines |
| [GLOSSARY.md](GLOSSARY.md) | source, stream source, call, record, batch, run, dead letter |
| [transformation/README.md](transformation/README.md) | dbt models and adding a chain |
| `.claude/skills/blockjuice/` | Question → mart → answer → report |

## Status

BlockJuice is under active development. The framework today is this repository: clone it, configure `.env`, and own the warehouse. Packaging for thinner customer apps is being designed; the contracts (exported `name`/`table`, mart shapes, `bj` CLI) are meant to stay stable as that lands.
