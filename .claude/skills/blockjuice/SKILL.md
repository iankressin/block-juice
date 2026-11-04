---
name: bj
description: blockjuice. Answers questions about blockchain data by building the sources, dbt models and reports it needs in this repo. Use for any on-chain question about wallets, tokens, protocols, volumes or balances, and to turn an answer into a PDF or spreadsheet.
argument-hint: "<question> | report <slug> | source <chain> <table> | pipeline <name>"
---

# blockjuice

Every answer comes from the warehouse, through files in this repo that anyone can rerun. Never answer from memory, a block explorer or an MCP tool alone.

Pick the workflow for the request and read it:

| Request | Workflow |
|---|---|
| A question about chain data | [workflows/answer.md](workflows/answer.md) |
| `report <slug>`, or the user wants an answer as a PDF or spreadsheet | [workflows/report.md](workflows/report.md) |
| Data that a view function or RPC method returns, which no source reads yet | [workflows/state-source.md](workflows/state-source.md) |
| Events, transfers or traces over a range of blocks that no source reads yet, or not far enough | [workflows/history-source.md](workflows/history-source.md) |
| A reusable mart that no pipeline builds yet | [workflows/new-pipeline.md](workflows/new-pipeline.md) |

Never stand in state reads for history ([references/choosing-the-data.md](references/choosing-the-data.md)). Exploring a protocol the catalog lacks is not built yet: when a question needs one, finish scoping, tell the user which protocol, and stop.

## Commands

Run commands from the repo root. The stack must be up (`docker compose up -d`), and `.env` must exist (`cp .env.example .env`). `bj run` also needs `pnpm install` in `ingestion/`, once per checkout.

- `uv run --project orchestration bj <command>` runs every mechanical step. It reads `.env` itself. `bj --help` lists the commands.
- dbt and Dagster read settings from the environment, so start each such command with `set -a && . ./.env && set +a &&`.

Use the words in [GLOSSARY.md](../../../GLOSSARY.md).
