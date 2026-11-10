# Polymarket trades, price charts and PnL: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `.claude/skills/blockjuice/references/layers.md` before any task.

**Goal:** For every Polymarket market, rebuild its price chart from on-chain fills and list every wallet that took part with its PnL, as marts in a `polymarket` pipeline, with market names and outcomes loaded from Polymarket's Gamma API.

**Architecture:** Stream sources load Polymarket's Polygon logs raw, one source per contract system. A call source loads Gamma's market list raw. dbt casts them in staging, applies each version's rules in its own intermediate model, and unions the versions into four marts: `polymarket_markets`, `polymarket_trades`, `polymarket_price_candles` and `polymarket_market_participants`.

**Tech Stack:** TypeScript sources on `@ingestion/lib` and Subsquid Pipes (`evmPortalStream`, `evmEventDecoder`), zod; dbt on Postgres; Dagster through `PIPELINES`.

**Spec:** the user's request (2026-11-07): "the mart tables should include for any prediction market, the full reconstruction of the price charts, list of all users who participated in the market with their PnL", plus Gamma metadata. The facts below are the rest of the spec.

## What we know

Polymarket runs on Polygon (Portal dataset `polygon-mainnet`, chain 137). It changed contracts twice in 2026, so three generations of contracts hold its history:

| Generation | Trading | Exchange contracts | Positions held in | Collateral |
|---|---|---|---|---|
| CTF Exchange v1 | until the cutover of 2026-04-28 ~11:00 UTC | CTF Exchange `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`, NegRisk CTF Exchange `0xC5d563A36AE78145C45a50134d48A1215220f80a` | ConditionalTokens `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | USDC.e `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| CTF Exchange v2 | 2026-04-28 on; markets created before Protocol V2 | `0xE111180000d2663C0091e4f400237545B87B996B`, NegRisk A `0xe2222d279d744050d28e00520010520000310F59`, NegRisk B `0xe2222d002000ba0053cef3375333610f64600036` | ConditionalTokens (unchanged) | pUSD `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`, 6 decimals |
| Protocol V2 | new markets from about 2026-11-02 | Exchange `0xe3333700cA9d93003F00f0F71f8515005F6c00Aa` | PositionManager `0x006F54F7f9A22e0000CC2AB60031000000ae9fEF`, through BinaryModule `0x1000008dD9001B968442c1000017eaE6E0dA00Ba`, NegRiskModule `0x200000900045e3B6259600682756002200028933`, CombinatorialModule `0x30000034706C7d8e12009DAB006Be20000c031A8`, Router `0x12121212006e4CD160D18e3f00711DA5c3372600` | pUSD |

Checked on chain on 2026-11-07: in block 96924040, `0xE111…996B` and `0xe2222d27…0F59` emitted 20 logs with three topic0s. They hash from the declarations in Protocol V2's `Exchange.sol`, so CTF Exchange v2 and Protocol V2 share one fill event:

| topic0 | Event |
|---|---|
| `0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee` (12 of the 20) | `OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee, bytes32 builder, bytes32 metadata)` |
| `0x174b3811690657c217184f89418266767c87e4805d09680c39fc9c031c0cab7c` | `OrdersMatched(bytes32 indexed takerOrderHash, address indexed takerOrderMaker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled)` |
| `0x55bb3cade9d43b798a4fe5ffdd05024b2d7870df53920673bfc7e68047cd0ab1` | `FeeCharged(address indexed receiver, uint256 amount)` |

v1's `OrderFilled` has a different shape, `(bytes32,address,address,uint256 makerAssetId,uint256 takerAssetId,uint256,uint256,uint256 fee)`, topic0 `0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6`, where asset id 0 is collateral.

From the contract sources (GitHub, read 2026-11-07):

- Every exchange emits one `OrderFilled` per maker order, with `taker` = the taker order's owner, and one more for the taker order, with `taker` = the exchange itself (`address(this)`). The second repeats the volume of the first ones.
- A match pairs a taker with makers on the same token (one buys, one sells), or on the two outcomes of one condition: two buys make the exchange split collateral (a mint), two sells make it merge. The exchange's own splits and merges show up in the position ledger's events with the exchange as the actor.
- Protocol V2 fees are in collateral: a buyer pays the fee on top, a seller has it taken from the proceeds. v1 charged a buyer's fee in outcome tokens.
- NegRiskAdapter (`0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`, address not yet checked) emits `PositionSplit`, `PositionsMerge`, `PositionsConverted(stakeholder, marketId, indexSet, amount)` and `PayoutRedemption(redeemer, conditionId, amounts[], payout)`. A conversion of `amount` NO tokens on k questions pays `(k − 1) × amountOut` collateral plus `amountOut` YES on every other question, where `amountOut = amount − amount × feeBips / 10000`.
- ConditionalTokens' `PayoutRedemption` names the payout but not the shares it burned; redeeming burns the whole balance of each index set it names.
- A Protocol V2 position id is `conditionId | outcomeIndex`: the top byte is the module (1 binary, 2 neg risk, 3 combinatorial), the low byte the outcome (0 YES, 1 NO). Module events: `PositionsSplit`, `PositionsMerged`, `PositionRedeemed(initiator, positionId, recipient, amount, payout)`, `ConditionResolved(conditionId, result[])` with result out of 1,000,000, `EventPrepared`, `MigrationConditionRegistered`, `BridgePositionMinted`, `BridgePositionsBurned`. Native conditions emit no "prepared" event.

Not yet proven, and owned by the task named: v1 and v2 addresses and deploy blocks (Task 1); which event names the wallet when a user splits, merges or redeems through pUSD's collateral adapters (Task 1, Q5); Gamma's fields, paging and rate limits (Task 2); Protocol V2 deploy blocks and ABIs (Task 11).

Sources: [polymarket-v2-external](https://github.com/Polymarket/polymarket-v2-external), [ctf-exchange](https://github.com/Polymarket/ctf-exchange), [neg-risk-ctf-adapter](https://github.com/Polymarket/neg-risk-ctf-adapter), [PolyNode V2 migration guide](https://docs.polynode.dev/guides/v2-migration), [nautilus_trader #3844](https://github.com/nautechsystems/nautilus_trader/issues/3844). `*.polymarket.com` does not resolve inside the Claude Code sandbox; read Gamma and Polymarket's docs from a shell outside it.

## Decisions

1. **Sources.** One per contract system, all Polygon-only, so named for the chain:

   | Package | Exports `name` / `table` | Raw table | Loads |
   |---|---|---|---|
   | `polymarket-markets` | `polymarket` / `markets` | `raw.polymarket_markets` | Gamma's market list, one record per market |
   | `polygon-polymarket-ctf` | `polygon` / `polymarket_ctf` | `raw.polygon_polymarket_ctf` | ConditionalTokens and NegRiskAdapter logs, plus whatever Task 1 Q5 finds for the collateral adapters |
   | `polygon-polymarket-ctf-exchange-v2` | `polygon` / `polymarket_ctf_exchange_v2` | `raw.polygon_polymarket_ctf_exchange_v2` | `OrderFilled` of the three v2 exchanges |
   | `polygon-polymarket-protocol-v2` | `polygon` / `polymarket_protocol_v2` | `raw.polygon_polymarket_protocol_v2` | Protocol V2 Exchange `OrderFilled` and the modules' events (Phase B) |
   | `polygon-polymarket-ctf-exchange-v1` | `polygon` / `polymarket_ctf_exchange_v1` | `raw.polygon_polymarket_ctf_exchange_v1` | v1 `OrderFilled` and `TokenRegistered` (Phase C, only on the user's go) |

   ConditionalTokens gets its own source because both exchange versions settle in it, and its splits, merges and redemptions run across the cutover.
   No source loads `OrdersMatched` or `FeeCharged`: the taker order's `OrderFilled` and each fill's `fee` carry the same facts. No source loads transactions: an operator signs every match, so `tx.from` names Polymarket, not the trader.
2. **Window.** The CTF-era sources start at the first block of 2026-10-01 UTC, the window the repo's other sources use. No v1 fill falls in it (Task 1 confirms). Protocol V2 starts at its first contract's deploy block, so its markets always have complete history. A market prepared before the window gets `history_complete = false`.
3. **Wallet.** The `maker` of an order: the proxy wallet or Safe that Polymarket shows as the trader's profile.
4. **Price chart.** `polymarket_trades` is the tick chart: one row per maker-order fill, at `price = usdc / shares` for the token traded. `polymarket_price_candles` gives 1-minute OHLC per outcome token. A condition with two outcomes shares one order book, so a fill of one outcome at `p` also prices the other at `1 − p`, and each token's candles use both.
5. **PnL.** Cash flow, marked to market, per condition and wallet:
   `pnl_usdc = Σ usdc_delta + Σ over the wallet's tokens (shares_held × mark_price)`.
   `usdc_delta` is cash after fees from trades, splits, merges, redemptions and conversions. `shares_held` is 0 when the wallet's last movement of the token was a redemption, otherwise the sum of `shares_delta`. `mark_price` is the payout fraction once the condition resolves, otherwise the close of the token's last candle, otherwise null, which leaves `pnl_usdc` null. A neg-risk conversion's collateral is split evenly across the k NO conditions it burned; PnL summed over a neg-risk event is exact, PnL of one of its conditions depends on that rule. Wallet-to-wallet moves of position tokens are not loaded: the receiver books them as free shares. Task 10 measures how often that happens.

## Model contracts

Every token id, position id and amount is `numeric`, never `bigint`: they are uint256. Addresses and hex ids are lowercase text. Amounts are base units in staging and divided by 1e6 in intermediate models (collateral and shares both have 6 decimals).

- `stg_polymarket__markets`: `market_id, condition_id, question_id, question, slug, event_id, event_slug, event_title, outcomes text[], clob_token_ids numeric[], neg_risk boolean, neg_risk_market_id, protocol_version, start_date, end_date, closed, created_at, updated_at, _loaded_at`.
- `stg_polygon__polymarket_ctf`: `id, event, block_number, block_timestamp, tx_hash, log_index, contract`, then each event's arguments: `condition_id, oracle, question_id, outcome_slot_count, payout_numerators numeric[], stakeholder, collateral_token, parent_collection_id, index_sets numeric[], amount, amounts numeric[], payout, neg_risk_market_id, index_set, fee_bips, question_index, outcome`.
- `stg_polygon__polymarket_ctf_exchange_v2` and `stg_polygon__polymarket_protocol_v2` (its fill columns): `id, event, block_number, block_timestamp, tx_hash, log_index, contract, order_hash, maker, taker, side smallint, token_id, maker_amount_filled, taker_amount_filled, fee, builder, metadata`.
- `int_polymarket_outcome_tokens`: `token_id` (unique), `condition_id, outcome_index, outcome, complement_token_id` (null unless the condition has two outcomes), `market_id, event_id, neg_risk, protocol` (`ctf` | `protocol_v2`).
- `int_<chain>_polymarket_<version>_fills`: `id, version` (`ctf_exchange_v1` | `ctf_exchange_v2` | `protocol_v2`), `exchange, block_number, block_timestamp, tx_hash, log_index, order_hash, wallet, counterparty, is_taker_order, token_id, side` (`buy` | `sell`), `shares, usdc, fee_usdc, price`. `usdc` is before fees.
- `int_polygon_polymarket_<system>_position_changes`: `id` (`<block>:<logIndex>:<token_id or 'cash'>`), `version, block_number, block_timestamp, tx_hash, log_index, kind` (`split` | `merge` | `redeem` | `convert`), `wallet, condition_id, token_id, shares_delta, usdc_delta, zeroes_position`.
- `int_polygon_polymarket_<system>_resolutions`: `condition_id, outcome_index, payout_fraction, resolved_block, resolved_at`.
- `int_polymarket_wallet_ledger`: `id, version, block_number, block_timestamp, tx_hash, log_index, kind` (`trade` | `split` | `merge` | `redeem` | `convert`), `wallet, condition_id, token_id, shares_delta, usdc_delta, fee_usdc, zeroes_position`.
- Marts:
  - `polymarket_markets`, one row per condition: `condition_id, market_id, question, slug, event_id, event_title, neg_risk, protocol, outcomes, end_date, prepared_block, resolved_at, payout_fractions numeric[], history_complete`.
  - `polymarket_trades`, one row per maker-order fill: `id, version, exchange, block_number, block_timestamp, tx_hash, log_index, condition_id, token_id, outcome, maker, taker, maker_side, shares, usdc, price, fee_usdc`.
  - `polymarket_price_candles`, one row per token and minute: `token_id, minute, condition_id, outcome, open, high, low, close, trades, shares_volume, usdc_volume`.
  - `polymarket_market_participants`, one row per condition and wallet: `condition_id, wallet, trades, buy_usdc, sell_usdc, fees_usdc, net_cash_usdc, open_shares, position_value_usdc, pnl_usdc, first_activity_at, last_activity_at, resolved, history_complete`.

## Global Constraints

- ELT: sources write each log as Portal returns it, with its ABI-decoded `args`, keyed `<block>:<logIndex>`, with `kind: "log"` and the event name. No sides, prices, units, joins or fee rules in TypeScript.
- Never change `ingestion/lib`, `runSource` or the Source contract. Each source reads only its own `.env` and `addresses.json`.
- Every address, deploy block, topic and field meaning comes from `catalog/protocols/polymarket/` or `catalog/vendors/polymarket/`, each proven on a real log or reply.
- Each intermediate rule has a dbt unit test built from a row of the catalog's proof table.
- Stream loads run with `uv run --project orchestration bj run polymarket` outside the sandbox. Gamma, the CLOB and the Data API are read outside it too.
- `polymarket` joins `PIPELINES` in `orchestration/pipeline/schedules.py` at `"0 6 * * *"`. `models/intermediate/polymarket` is materialized as `view` in `dbt_project.yml`, like `dex`.
- Prose in the catalog and model comments follows the repo's style: short words, active voice, the words in `GLOSSARY.md`.
- Work on a branch, not `main`.

## Review Focus

1. **The taker order's fill counted as a trade.** It doubles volume and adds a second price. `polymarket_trades` must keep only rows where `taker` is not the emitting exchange, and the ledger must keep both. Test: `trades_keep_maker_fills_only` (Task 9).
2. **Mint and merge matches.** Maker and taker hold opposite outcomes, so a rule that assumes one token flips the taker's side or price. Test: `fills_of_a_mint_match_are_two_buys` (Task 7).
3. **The exchange's or adapter's own split, merge or redemption booked as the user's.** It adds cash flows that the fills already hold. Test: `splits_by_polymarket_contracts_are_dropped` (Task 8).
4. **Outcome order.** If Gamma's `clobTokenIds` order and the payout vector disagree, charts and PnL swap YES and NO. Test: `resolved_proof_market_pays_its_winner` (Task 6), from a market Gamma marks resolved.
5. **Partial history shown as complete.** A market prepared before the window has a cut chart and wrong PnL. Test: `markets_prepared_before_coverage_are_incomplete` (Task 9).

---

## Phase A: CTF markets from 2026-10-01

### Task 1: Catalog entry for the CTF era

**Files:**
- Create: `catalog/protocols/polymarket/protocol.yaml`, `catalog/protocols/polymarket/NOTES.md`, `catalog/protocols/polymarket/abis/{conditional-tokens,neg-risk-adapter,ctf-exchange-v2}.json` (events only)

**Interfaces:**
- Produces: events keyed by version (`ctf.PositionSplit`, `neg_risk.PositionsConverted`, `ctf_exchange_v2.OrderFilled`, …) with topic0 and ABI file; contracts with address, deploy block and how each was confirmed; a proof table whose rows later tasks cite by number; answers to Q1–Q7 in `NOTES.md`; the window's first block.

- [ ] **Step 1:** Follow `.claude/skills/blockjuice/workflows/explore-protocol.md`, with `catalog/protocols/uniswap/` as the model. Resolve the first block of 2026-10-01 UTC with `portal_debug_resolve_time_to_block` and record it under "Time window used for checks".
- [ ] **Step 2:** Confirm each address in "What we know" and its deploy block with `portal_evm_get_contract_deployment`, and the addresses against Polymarket's contracts page (read outside the sandbox).
- [ ] **Step 3:** Write the ABIs from the published sources and compute each topic0 with a script. The three exchange topics must equal those in "What we know".
- [ ] **Step 4:** Prove each event on a real transaction, checked against the pUSD, USDC.e and ConditionalTokens `TransferSingle`/`TransferBatch` logs in the same transaction. Proof rows: (1) a match of a buy against a sell, with its maker and taker `OrderFilled`; (2) a mint match; (3) a merge match; (4) a user's split; (5) a merge; (6) a ConditionalTokens redemption; (7) a NegRiskAdapter redemption; (8) a conversion; (9) a `ConditionResolution` of a market Gamma lists as resolved; (10) a fill with a non-zero fee.
- [ ] **Step 5:** Answer in `NOTES.md`, each with its proof row:
  - Q1: which asset each of `makerAmountFilled` and `takerAmountFilled` counts for a buy and a sell, and whether the fee is paid on top or taken from the proceeds.
  - Q2: the taker order's `OrderFilled` has `taker` = the emitting exchange, on all three v2 exchanges.
  - Q3: whether the v2 exchanges emit any token registry event. If not, token to condition comes from Gamma only.
  - Q4: every Polymarket contract that appears as `stakeholder` or `redeemer` for its own splits, merges and redemptions. These rows become the `polymarket_contracts` seed.
  - Q5: which event names the wallet when a user splits, merges or redeems with pUSD through the collateral adapters, including the adapters replaced on 2026-05-01. If no event names the wallet, the source also loads ConditionalTokens `TransferSingle`/`TransferBatch` whose `operator` (topic1) is an adapter.
  - Q6: Gamma's `clobTokenIds` order matches outcome index i, index set `1 << i` and `payoutNumerators[i]`.
  - Q7: where a conversion's `feeBips` comes from (`MarketPrepared`) and how the YES tokens of a conversion are attributed to questions.
- [ ] **Step 6:** Estimate the load: count `OrderFilled` and the ConditionalTokens and NegRiskAdapter logs over 2,000 blocks with `portal_evm_query_logs`, one call at a time, and scale to the window. Count v1 `OrderFilled` in the same blocks; expect 0. Write the estimate in `NOTES.md` and show it to the user before Task 10's full load.
- [ ] **Step 7:** Commit: `git add catalog/protocols/polymarket && git commit -m "Add the Polymarket CTF-era catalog entry"`

### Task 2: Vendor entry for Gamma

**Files:**
- Create: `catalog/vendors/polymarket/vendor.yaml`, `catalog/vendors/polymarket/NOTES.md` (model: `catalog/vendors/coinbase/`)

**Interfaces:**
- Produces: the markets endpoint's paging (keyset or offset, the largest `limit`, any cap on `offset`), its order and filters, the default for `closed`, every field `stg_polymarket__markets` reads with its JSON type (whether `outcomes` and `clobTokenIds` are JSON-encoded strings), the field that names a market's protocol version, the rate limit and the reply to too many requests. Also the CLOB `prices-history` and Data API positions endpoints Task 10 uses for cross-checks.

- [ ] **Step 1:** Read Gamma's docs and real replies with `curl` outside the sandbox. Record each fact with the reply that shows it.
- [ ] **Step 2:** Count all markets (and those with `closed=false`) and work out how many requests one run of the full list takes at the rate limit. If it takes more than 10 minutes, record the filter that cuts it (such as an end-date minimum) and use it in Task 3.
- [ ] **Step 3:** Proof table: one CTF binary market, one neg-risk market and one Protocol V2 market, each with its token ids.
- [ ] **Step 4:** Commit: `git add catalog/vendors/polymarket && git commit -m "Add the Polymarket Gamma vendor entry"`

### Task 3: `polymarket-markets` call source

**Files:**
- Create (by `uv run --project orchestration bj new-source polymarket markets --like coinbase-candles`, then edit): `ingestion/sources/polymarket-markets/src/{source.ts,gamma.ts,markets.ts,source.test.ts}`, `.env.example`
- Delete: the copied `tokens.json`
- Create: `transformation/models/staging/polymarket/{_polymarket__sources.yml,_polymarket__models.yml,stg_polymarket__markets.sql}`
- Modify: `ingestion/sources.json` (regenerated)

**Interfaces:**
- Produces: `marketsSource(clock?: Clock): Source<GammaEnv, MarketsPageCall>`, exported as `polymarketMarkets`; `MarketsPageCall = { kind: "markets_page", offset: number, limit: number }` (or the keyset cursor Task 2 found) with `callId = "markets:<offset>"`; records `{ id: "market:<gamma id>", callId, data: <the market object as Gamma sent it> }`.
- Env: `GAMMA_API_URL` (default `https://gamma-api.polymarket.com`), `GAMMA_PAGE_SIZE` (default and maximum from Task 2), `GAMMA_MAX_CONCURRENCY` (bounded by Task 2's rate limit).

- [ ] **Step 1: Write the failing tests** in `source.test.ts`, against a fake Gamma server like `fakeCoinbase`:
  - `pages until a short page, one record per market holding the object as sent`: 3 pages of sizes 2, 2, 1 at `GAMMA_PAGE_SIZE=2` give 5 records with ids `market:<id>` and `data` deep-equal to the served objects.
  - `a failed page becomes a dead letter and the other pages still load`: page 2 answers 500; the batch holds pages 1 and 3's records and one failed call with id `markets:2`.
  - `a 429 is retried and then succeeds`.
  - `a retried page replaces its new twin`: retry `[markets:0]` plus new calls gives one call per id.
  - `a reply in an unexpected shape fails the page and names the field`.
- [ ] **Step 2:** Run `pnpm --filter @ingestion/polymarket-markets test`. Expected: FAIL.
- [ ] **Step 3:** Implement `source.ts`, `gamma.ts` (client with pacing and 429 retries, as `coinbase.ts`) and `markets.ts` (call schema, `callId`, `fetchPages`). The zod schema checks only `id` and that the reply is an array of objects; the record keeps every field.
- [ ] **Step 4:** Run the tests and `pnpm typecheck` in `ingestion/`. Expected: PASS.
- [ ] **Step 5:** Write `stg_polymarket__markets.sql` per "Model contracts": parse the JSON-encoded strings Task 2 names, cast token ids to `numeric`, lowercase hex ids. Add `not_null` and `unique` on `market_id` in `_polymarket__models.yml`.
- [ ] **Step 6:** Run `cd ingestion && pnpm generate-sources`, then `cd orchestration && uv run pytest tests/test_sources_json.py`. Expected: PASS.
- [ ] **Step 7:** Commit the package, staging folder and `ingestion/sources.json`: `git commit -m "Add the polymarket-markets source"`

### Task 4: `polygon-polymarket-ctf` stream source

**Files:**
- Create (by `bj new-source polygon polymarket_ctf --like arbitrum-token-bridge`, then edit): `ingestion/sources/polygon-polymarket-ctf/{addresses.json,.env.example,src/source.ts,src/source.test.ts}`
- Create: `transformation/models/staging/polygon/{_polygon__sources.yml,_polygon__models.yml,stg_polygon__polymarket_ctf.sql}`

**Interfaces:**
- Consumes: Task 1's ABIs from `catalog/protocols/polymarket/abis/`, its addresses and Q5 answer.
- Produces: `polygonPolymarketCtf: StreamSource<CtfEnv>` with `name: "polygon"`, `table: "polymarket_ctf"`. `addresses.json`: `{ "conditional_tokens": "0x…", "neg_risk_adapter": "0x…", "collateral_adapters": ["0x…"] }`. Env: `PORTAL_URL=https://portal.sqd.dev/datasets/polygon-mainnet`, `PORTAL_API_KEY`, `START_BLOCK` (Task 1's window block), `END_BLOCK`.
- Records: `{ kind: "log", event, block_number, timestamp, tx_hash, log_index, contract, args }`, id `<block>:<logIndex>`.

- [ ] **Step 1: Write the failing tests** with `mockPortal` and `encodeEvent`, as `evm-chainlink-price-feeds/src/source.test.ts` does:
  - `each listed event of ConditionalTokens and NegRiskAdapter becomes a record with its decoded args`: one log per event in Task 1's `ctf.*` and `neg_risk.*` keys.
  - `the same events from another contract are left out`.
  - `the stream starts at START_BLOCK and stops at END_BLOCK`.
  - `an addresses.json without conditional_tokens fails the run`.
  - If Q5 added transfers: `TransferSingle with an adapter as operator is kept and one with another operator is not`.
- [ ] **Step 2:** Run `pnpm --filter @ingestion/polygon-polymarket-ctf test`. Expected: FAIL.
- [ ] **Step 3:** Implement `source.ts`: one `evmEventDecoder` per contract (one per filter, since Pipes refuses two filters on one event), range `[START_BLOCK, min(END_BLOCK, finalizedHead(portal))]`.
- [ ] **Step 4:** Run the tests and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Write the staging model per "Model contracts", one column per argument, arrays cast to `numeric[]`. Tests: `unique` and `not_null` on `id`, `accepted_values` on `event`.
- [ ] **Step 6:** `pnpm generate-sources`; `uv run pytest tests/test_sources_json.py`. Expected: PASS.
- [ ] **Step 7:** Commit: `git commit -m "Add the polygon-polymarket-ctf source"`

### Task 5: `polygon-polymarket-ctf-exchange-v2` stream source

**Files:**
- Create (by `bj new-source polygon polymarket_ctf_exchange_v2 --like arbitrum-token-bridge`): `ingestion/sources/polygon-polymarket-ctf-exchange-v2/{addresses.json,.env.example,src/source.ts,src/source.test.ts}`
- Create: `transformation/models/staging/polygon/stg_polygon__polymarket_ctf_exchange_v2.sql`; modify `_polygon__sources.yml`, `_polygon__models.yml`

**Interfaces:**
- Produces: `polygonPolymarketCtfExchangeV2: StreamSource<ExchangeEnv>`, `name: "polygon"`, `table: "polymarket_ctf_exchange_v2"`. `addresses.json`: `{ "exchanges": ["0xe111…", "0xe2222d27…", "0xe2222d00…"] }` in full. Same env and record shape as Task 4. Loads `OrderFilled`, plus Q3's registry event if one exists.

- [ ] **Step 1: Write the failing tests:** `OrderFilled from each listed exchange becomes a record` (all three addresses); `OrderFilled from an unlisted contract is left out`; `START_BLOCK and END_BLOCK bound the stream`; `an empty exchanges list fails the run`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement `source.ts`.
- [ ] **Step 4:** Run the tests and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Staging model with `side` as `smallint` and amounts as `numeric`. Tests: `unique`/`not_null` on `id`, `accepted_values` on `side` (0, 1).
- [ ] **Step 6:** `pnpm generate-sources`; `uv run pytest tests/test_sources_json.py`. Expected: PASS.
- [ ] **Step 7:** Commit: `git commit -m "Add the polygon-polymarket-ctf-exchange-v2 source"`

### Task 6: Outcome tokens, Polymarket contracts and resolutions

**Files:**
- Create: `transformation/seeds/polymarket_contracts.csv` (`address,role,version`), with its entry in `_seeds.yml`
- Create: `transformation/models/intermediate/polymarket/{_int_polymarket__models.yml,int_polymarket_outcome_tokens.sql,int_polygon_polymarket_ctf_resolutions.sql}`
- Modify: `transformation/dbt_project.yml` (`polymarket: +materialized: view` under `intermediate`, with a comment like `dex`'s)
- Test: `ingestion/sources/polygon-polymarket-ctf/src/source.test.ts` and `…-ctf-exchange-v2/src/source.test.ts`

**Interfaces:**
- Consumes: `stg_polymarket__markets`, `stg_polygon__polymarket_ctf`.
- Produces: `int_polymarket_outcome_tokens`, `int_polygon_polymarket_ctf_resolutions`, seed `polymarket_contracts` (roles: `exchange`, `neg_risk_adapter`, `collateral_adapter`, `operator` as Q4 finds).

- [ ] **Step 1: Write the failing tests:**
  - dbt unit test `outcome_tokens_follow_gamma_order`: Task 2's binary proof market gives two rows, outcome_index 0 and 1, each the other's `complement_token_id`.
  - dbt unit test `resolved_proof_market_pays_its_winner`: proof row 9's `ConditionResolution` with Gamma's market gives `payout_fraction` 1 for the outcome Gamma marks as the winner and 0 for the other.
  - TS test in each source package: `every exchange and adapter in addresses.json has a row in the polymarket_contracts seed`, as the chainlink test checks its seed.
- [ ] **Step 2:** Run `dbt build --select int_polymarket_outcome_tokens int_polygon_polymarket_ctf_resolutions` (with the `.env` prefix from the skill) and the two package tests. Expected: FAIL.
- [ ] **Step 3:** Write the seed and both models. `payout_fraction = payout_numerators[i] / sum(payout_numerators)`.
- [ ] **Step 4:** Run them again. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Map Polymarket tokens to outcomes and read CTF resolutions"`

### Task 7: CTF Exchange v2 fills

**Files:**
- Create: `transformation/models/intermediate/polymarket/int_polygon_polymarket_ctf_exchange_v2_fills.sql`; unit tests in `_int_polymarket__models.yml`

**Interfaces:**
- Consumes: `stg_polygon__polymarket_ctf_exchange_v2`.
- Produces: rows per the fills contract, `version = 'ctf_exchange_v2'`. `is_taker_order = (taker = contract)`. `side = case side when 0 then 'buy' else 'sell' end`. Units and fee placement per Q1.

- [ ] **Step 1: Write the failing unit tests**, each from its proof row:
  - `fills_of_a_buy_against_a_sell` (row 1): the maker row and the taker row have opposite sides on the same token, equal shares, and `price` equal to the hand-computed price in `NOTES.md`.
  - `fills_of_a_mint_match_are_two_buys` (row 2): maker and taker both `buy`, on complementary tokens, and their prices sum to 1.
  - `fills_of_a_merge_match_are_two_sells` (row 3).
  - `fee_follows_q1` (row 10): `fee_usdc` and `usdc` match the pUSD transfers of the proof transaction.
  - `the_taker_order_is_marked`: only the row whose `taker` equals `contract` has `is_taker_order = true`.
- [ ] **Step 2:** Run `dbt build --select int_polygon_polymarket_ctf_exchange_v2_fills`. Expected: FAIL.
- [ ] **Step 3:** Write the model. Start it with a comment that names the rules and their proof rows, as `int_ethereum_uniswap_v4_trades.sql` does.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Read CTF Exchange v2 fills"`

### Task 8: CTF position changes

**Files:**
- Create: `transformation/models/intermediate/polymarket/int_polygon_polymarket_ctf_position_changes.sql`; unit tests in `_int_polymarket__models.yml`

**Interfaces:**
- Consumes: `stg_polygon__polymarket_ctf`, `int_polymarket_outcome_tokens`, seed `polymarket_contracts`.
- Produces: rows per the position-changes contract, `version = 'ctf'`.

Rules: drop any event whose `stakeholder` or `redeemer` is in `polymarket_contracts`, and take the user's own event per Q5. A split gives `usdc_delta = −amount` and `+amount` of each outcome token; a merge the opposite. A ConditionalTokens redemption gives `+payout` on a cash row and, for each token of each index set it names, a row with `shares_delta = null`, `zeroes_position = true`. A NegRiskAdapter redemption gives `−amounts[i]` per token and `+payout`. A conversion follows "What we know" and Decision 5.

- [ ] **Step 1: Write the failing unit tests:**
  - `splits_by_polymarket_contracts_are_dropped`: proof row 2's split, whose stakeholder is the exchange, gives no row.
  - `a_user_split_buys_both_outcomes` (row 4) and `a_user_merge_sells_both_outcomes` (row 5).
  - `a_ctf_redemption_pays_and_zeroes_the_position` (row 6).
  - `a_neg_risk_redemption_burns_its_amounts` (row 7).
  - `a_conversion_burns_no_tokens_mints_yes_tokens_and_splits_its_cash` (row 8): the cash rows sum to `(k − 1) × amountOut`, one per NO condition, equal amounts.
- [ ] **Step 2:** Run `dbt build --select int_polygon_polymarket_ctf_position_changes`. Expected: FAIL.
- [ ] **Step 3:** Write the model.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Read CTF splits, merges, redemptions and conversions"`

### Task 9: Ledger, marts, checks and schedule

**Files:**
- Create: `transformation/models/intermediate/polymarket/int_polymarket_wallet_ledger.sql`
- Create: `transformation/models/marts/polymarket/{_polymarket__models.yml,polymarket_markets.sql,polymarket_trades.sql,polymarket_price_candles.sql,polymarket_market_participants.sql}`
- Create: `transformation/tests/{polymarket_prices_within_unit_interval.sql,polymarket_payouts_sum_to_one.sql,polymarket_resolved_markets_are_zero_sum.sql}`
- Modify: `orchestration/pipeline/schedules.py` (`"polymarket": "0 6 * * *"`)

**Interfaces:**
- Consumes: every model above.
- Produces: the four marts per "Model contracts". The ledger and `polymarket_trades` union the version models with `select <columns> from … union all …`, as `dex_trades.sql` does; Phase B and C add one branch each.

Rules: `polymarket_trades` keeps fills with `is_taker_order = false`. `polymarket_price_candles` takes each trade at `price` for its token and at `1 − price` for `complement_token_id`, grouped by `date_trunc('minute', block_timestamp)`. `history_complete` holds when the condition's `ConditionPreparation` block is at or after the coverage start, the greatest of each Polymarket raw table's lowest block number. `polymarket_market_participants` applies Decision 5. Start each mart's SQL with a comment that says what one row is and its units.

- [ ] **Step 1: Write the failing tests:**
  - Unit test `trades_keep_maker_fills_only` (proof row 1): the taker order's fill does not reach `polymarket_trades`.
  - Unit test `a_no_trade_also_prices_yes`: a NO fill at 0.30 gives the YES candle a close of 0.70.
  - Unit test `pnl_of_a_resolved_market`: made-up rows for one wallet (buy 100 YES at 0.40, sell 40 at 0.55, market resolves YES, 60 unredeemed) give `net_cash_usdc = −18`, `position_value_usdc = 60`, `pnl_usdc = 42`.
  - Unit test `pnl_after_redemption_counts_cash_only`: the same wallet redeems; `position_value_usdc = 0`, `pnl_usdc = 42`.
  - Unit test `markets_prepared_before_coverage_are_incomplete`.
  - Schema tests: `unique` on `polymarket_trades.id` and `polymarket_markets.condition_id`; `not_null` on keys; `accepted_values` on `version` and `maker_side`. One row per (`token_id`, `minute`) and per (`condition_id`, `wallet`) as singular tests, like `token_prices_one_row_per_candle.sql`.
  - `polymarket_prices_within_unit_interval.sql`: no trade price outside (0, 1].
  - `polymarket_payouts_sum_to_one.sql`: each resolved condition's payout fractions sum to 1.
  - `polymarket_resolved_markets_are_zero_sum.sql`: for each resolved, `history_complete`, non-neg-risk condition, `abs(sum(pnl_usdc) + sum(fees_usdc))` is at most 0.000001 × the count of its wallets. For neg-risk, the same per event, over events whose `feeBips` is 0 and whose conditions have all resolved. A failure means the ledger misses a channel.
- [ ] **Step 2:** Run `dbt build --select +path:models/marts/polymarket` against empty raw tables. Expected: the unit tests FAIL.
- [ ] **Step 3:** Write the ledger and the four marts, and add the line to `PIPELINES`.
- [ ] **Step 4:** Run the dbt build and `cd orchestration && uv run pytest`. Expected: PASS, including `test_every_asset_and_check_runs_in_a_scheduled_pipeline`.
- [ ] **Step 5:** Commit: `git commit -m "Add the polymarket pipeline: trades, price candles, markets and participants"`

### Task 10: Check window, cross-checks and the full load

**Files:**
- Modify: `catalog/protocols/polymarket/NOTES.md` (results of the checks)

- [ ] **Step 1:** In each stream package's `.env`, set `RAW_SCHEMA=raw_polymarket_check` and `START_BLOCK`/`END_BLOCK` 3,000 blocks apart inside the window. Load with `bj run polymarket` outside the sandbox, then build with `RAW_SCHEMA=raw_polymarket_check DBT_SCHEMA=analytics_polymarket_check` per `history-source.md` step 7.
- [ ] **Step 2:** Compare the raw row counts per event with Portal MCP counts over the same blocks and contracts. Expected: equal.
- [ ] **Step 3:** Cross-check prices: for three tokens of busy markets, compare `polymarket_price_candles.close` with the CLOB `prices-history` at 1-minute fidelity over the window. Write down how close they are; Polymarket's chart may plot the midpoint, not the last trade.
- [ ] **Step 4:** Cross-check PnL: for five wallets in one resolved market whose whole life lies inside a check window, compare `pnl_usdc` with Polymarket's Data API positions (Task 2 names the endpoint). Write down each difference and its cause.
- [ ] **Step 5:** Measure Decision 5's gap: over the check window, count ConditionalTokens `TransferSingle`/`TransferBatch` between two wallets that are neither a Polymarket contract nor the zero address (Portal MCP, a few hundred blocks). If they are more than 1% of fills, ask the user whether to load them.
- [ ] **Step 6:** Show the user Task 1's load estimate. With their go, restore `RAW_SCHEMA=raw` and the window's `START_BLOCK`, unset `END_BLOCK`, run `bj run polymarket` until `bj coverage polygon.polymarket_ctf` and `bj coverage polygon.polymarket_ctf_exchange_v2` reach the head, and run the dbt build. Expected: every test passes.
- [ ] **Step 7:** Commit the notes: `git commit -m "Record the Polymarket check window and cross-checks"`

## Phase B: Protocol V2 markets

### Task 11: Catalog section for Protocol V2

**Files:**
- Modify: `catalog/protocols/polymarket/protocol.yaml`, `NOTES.md`; create `abis/{protocol-v2-exchange,protocol-v2-module}.json`

- [ ] **Step 1:** Confirm each Protocol V2 address and deploy block (proxies from the table in "What we know"; read events at the proxy address).
- [ ] **Step 2:** ABIs from `polymarket-v2-external`'s sources, including `BinaryModule.sol`, `NegRiskModule.sol` and `Router.sol`, which the research did not read.
- [ ] **Step 3:** Proof rows: a fill of each match kind, a split and merge through the Router, a redemption by a user and one by the AutoRedeemer (`0xa1200000d0002264C9a1698e001292D00E1b00af`), a `ConditionResolved`, and a migration (`MigrationConditionRegistered` plus `BridgePositionMinted`, with the CTF side of the same move).
- [ ] **Step 4:** Answer in `NOTES.md`: Q8, which address in each module event is the wallet (`initiator` or `recipient`); Q9, which `initiator` values are the Exchange's own splits and merges (they join the seed); Q10, how a migrated position shows on the CTF side, and so how the ledger keeps a wallet's PnL whole across the move; Q11, whether Gamma's `clobTokenIds` holds V2 position ids for V2 markets.
- [ ] **Step 5:** Commit: `git commit -m "Add Protocol V2 to the Polymarket catalog entry"`

### Task 12: `polygon-polymarket-protocol-v2` source

As Task 5, with `bj new-source polygon polymarket_protocol_v2 --like arbitrum-token-bridge`, `addresses.json` `{ "exchange": "0x…", "modules": ["0x…", "0x…", "0x…"] }`, `START_BLOCK` defaulting to the earliest deploy block from Task 11, and tests named `OrderFilled from the Exchange becomes a record`, `each module event becomes a record`, `events from an unlisted contract are left out`, `START_BLOCK and END_BLOCK bound the stream`. Staging: `stg_polygon__polymarket_protocol_v2.sql`. Commit: `"Add the polygon-polymarket-protocol-v2 source"`.

### Task 13: Protocol V2 models

**Files:**
- Create: `int_polygon_polymarket_protocol_v2_fills.sql`, `int_polygon_polymarket_protocol_v2_position_changes.sql`, `int_polygon_polymarket_protocol_v2_resolutions.sql`
- Modify: `int_polymarket_outcome_tokens.sql` (V2 tokens: `outcome_index = token_id % 256`, `condition_id` = the top 31 bytes, labels from Gamma), `int_polymarket_wallet_ledger.sql` and `polymarket_trades.sql` (one more `union all` branch each), `polymarket_markets.sql` (a V2 condition has no preparation event and its source starts at deployment, so `history_complete` is true), `polymarket_contracts.csv` (Q9)

- [ ] **Step 1: Write the failing unit tests** from Task 11's proof rows: `v2_fills_follow_the_ctf_exchange_v2_rules`, `v2_position_id_names_its_condition_and_outcome`, `v2_redemption_burns_its_amount_and_pays`, `v2_exchange_splits_are_dropped`, `v2_payout_fraction_is_result_over_one_million`, and `a_migrated_position_keeps_its_pnl` per Q10.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Write the models and branches.
- [ ] **Step 4:** Run the check window of Task 10 for the new source, then the full build. Expected: every test passes, the zero-sum test included.
- [ ] **Step 5:** Commit: `git commit -m "Add Protocol V2 markets to the polymarket pipeline"`

## Phase C: history before 2026-04-28 (ask the user first)

### Task 14: `polygon-polymarket-ctf-exchange-v1`

Only on the user's go, after they see a load estimate: v1 ran from 2022, so its history is far larger than the window. Add `ctf_exchange_v1.*` to the catalog (asset id 0 is collateral; a buyer's fee is in outcome tokens, valued at the fill price in the ledger; `TokenRegistered(token0, token1, conditionId)` maps tokens to conditions for markets Gamma no longer lists). Then a source like Task 5, `int_polygon_polymarket_ctf_exchange_v1_fills.sql` with unit tests `v1_asset_id_zero_is_collateral` and `v1_buy_fee_is_paid_in_shares`, one more branch in the ledger and `polymarket_trades`, and an earlier `START_BLOCK` for `polygon-polymarket-ctf`, which means resetting that source per `history-source.md`.
