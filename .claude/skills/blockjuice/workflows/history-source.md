# Add or extend a history source

A history source is a Pipes stream source. It reads events over a range of blocks from SQD Portal, and each run resumes after the last block it saved. `ingestion/sources/ethereum-erc20-transfers/` is the pattern: every Transfer of the tokens in its `addresses.json` into or out of its wallets, from `START_BLOCK` on.

## What a history source has loaded

```sh
uv run --project orchestration bj coverage <chain>.<table>
```

It prints `start_block`, the `cursor` (the last block saved, from Pipes' cursor table `raw._sync`), the `filter` (the source's `addresses.json`) and `covered: [start_block, cursor]`. Coverage assumes the filter has not changed since `START_BLOCK`.

## Reuse before you build

When a source already reads the right events:

- The window is inside `covered` and the addresses are in its filter: nothing to load.
- The window ends after the cursor: run its pipeline with `bj run <pipeline>` until `bj coverage` shows a cursor at or after the window's last block. Each run reads at most about a million blocks.
- The window starts before `START_BLOCK`, or the question needs addresses the filter lacks: the source must be reset. Resetting deletes the source's raw rows and its cursor, then reloads everything from the new `START_BLOCK`. Ask the user first, and show them what the reload will read. With their go, edit `addresses.json` or `START_BLOCK`, then run:

  ```sql
  delete from raw._sync where id = '<chain>_<table>';
  truncate raw.<chain>_<table>;
  ```

## A new history source

1. Find the events in the protocol's catalog entry, `catalog/protocols/<name>/`. With no entry, follow [explore-protocol.md](explore-protocol.md) first.
2. Estimate the load before you build: count the matching logs over a few thousand blocks of the window with the Portal MCP (`portal_evm_query_logs`), scale it, and call it an estimate, since a thin sample can be far off. Put it in front of the user with the definitions, per [answer.md](answer.md). Never write a script to count, and never count the whole window: the estimate exists so the user can decide on the full load.
3. Build one source per protocol version, each with its own raw table, per [../references/layers.md](../references/layers.md). A question over Uniswap v2, v3 and v4 needs three sources: `ethereum-uniswap-v2`, `ethereum-uniswap-v3` and `ethereum-uniswap-v4`. Scaffold each from the transfers source:

   ```sh
   uv run --project orchestration bj new-source ethereum uniswap_v3 --like ethereum-erc20-transfers
   ```

   That makes the package `ethereum-uniswap-v3` and the raw table `raw.ethereum_uniswap_v3`, which holds every event of that version the question needs, such as its pool creations and its swaps.

4. Edit the copied `src/source.ts`. It extracts and loads only, per [../references/layers.md](../references/layers.md): each record is one log as emitted, with its ABI-decoded arguments and the transaction fields the models need, such as `tx.from`.
   - Read `[START_BLOCK, finalizedHead(portal)]` through `portalClient`, so each run ends at Portal's finalized head and no fork reaches the warehouse.
   - Key each record by its place in the chain, `<block>:<logIndex>`, so a rerun or an overlap writes the same row.
   - One `evmEventDecoder` per filter, since Pipes refuses two filters on the same event in one decoder.
   - For contracts a factory creates, such as Uniswap pools, follow the children with Pipes' factory pattern inside the stream. Never read another source's raw table to find them.
   - Put addresses in `addresses.json`, and set `START_BLOCK` in `.env.example` to the window's first block or the contract's deployment block.
   - Leave out sign rules, joins, buy or sell, units and prices. They go in dbt.
5. Cast the fields in one staging model per source. Put each version's rules from the catalog's `NOTES.md` in that version's intermediate model, with a dbt unit test per rule built from a proof log. A mart that needs every version unions those models. Add the mart in a pipeline ([new-pipeline.md](new-pipeline.md)), with `unique` and `not_null` tests on the id.
6. When a view function returns the value the events rebuild, add a reconciliation test like `transformation/tests/erc20_transfers_match_balances.sql`. It reads what the source has loaded from `var('coverage')`, which `bj answer` passes, and compares the rebuilt value with state readings inside the loaded blocks.
7. Check it on a short window first: set `START_BLOCK` in the package's `.env` a few thousand blocks before a recent block, run it, and compare its rows with a count of the same blocks and filter from the Portal MCP. Then set the real `START_BLOCK`, load with `bj run <pipeline>`, and check `bj coverage`.

## Use it in an answer

In `question.yaml`, name the source on its input, quote every address, and give the window in blocks:

```yaml
window:
  chain: ethereum
  blocks: [26316189, 26343605]
inputs:
  - name: usdc_flows
    strategy: history
    source: ethereum.erc20_transfers
    filter: {tokens: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"]}
```

`bj answer` then adds a `coverage` check. After it passes, run the cross-check in [../references/checks.md](../references/checks.md).

## Sandboxed shells

If `pnpm ingest` fails with `listen EPERM`, or Portal calls fail with `ENOTFOUND` behind a proxy, run the source directly in its package with `NODE_USE_ENV_PROXY=1 node --import tsx src/index.ts`.
