# Lighter drain: implementation plan

> **For implementers:** this is a plan. Do not add sources, decoders, dbt models, Dagster assets or configs from it until Ian says go. Do not run a pipeline, a backfill or a data pull. Read `.claude/skills/blockjuice/references/layers.md` before any task. Words are the ones in `GLOSSARY.md`. The person reading the result is an analyst.

**Goal:** Rebuild the trail of the 10,393,056.79 USDC that left Lighter's L1 contract, and show where that trail matches or misses the reported figures. A mismatch is the finding. The chain does not show cause.

**Issue:** [Analysis #70](https://github.com/iankressin/block-juice/issues/70). Approved card and Analyst pins, 16 Nov 2026. Quality Gate passed #70 with no blockers.

**Baseline:** `main` @ `9efbc61`. Facts below were read from that tree.

**Cutoff:** 2026-11-16 17:00:00 UTC. Finalized blocks only. Ethereum models stop at block 26428942 (last block with `timestamp <= 17:00:00`). Arbitrum models stop at block 524806268, the conservative finalized end from the trace. Do not write those ends into a shared `.env.example`: that would freeze every later run of the shared sources. The Lighter models filter to the cutoff. A reproducing run may set `END_BLOCK` for that run only, then unset it.

**Status:** nothing is built until Ian says go. No backfill until he approves one.

## Objectives

An analyst can reproduce a fixed trail: one USDC withdrawal, six CoW fills, the ETH splits, an inferred hop from Ethereum to Arbitrum, and twelve USDC deposits into the Hyperliquid bridge. Reported figures sit beside the observed ones. Rows that were not followed stay open at the cutoff.

Three shared components are defined once, so later cards can use them without a second copy. Possible future consumers, not part of this work: the pending EF-history wallet ETH sales, and the pending named-whale ETH buys.

## Non-goals

- No automatic hop-following crawler. The wallet list is the seed below, fixed at the cutoff.
- No Relay decoder. Funding counterparties stay leads.
- No Lighter withdrawal decoder. The withdrawal is a plain USDC `Transfer`.
- No bridge decoder. An Ethereum send and an Arbitrum USDC receipt join on wallet address, and the reconciliation marks that join inferred.
- Hyperliquid past the bridge deposit is out of scope, a separate later decision.
- The untraced amount (0xTria's rounded $15.5M total minus the 10,393,056.79 USDC withdrawal) is out of scope. The plan gives it no place.
- No size cutoff on fills. A decoding coverage check lists any excluded fill and why.

## What main contains

Checked on `main` @ `9efbc61`. These findings are the reason the file list below is what it is.

**ERC-20 transfers.** `evm-erc20-transfers` already runs on Arbitrum. `chains/arbitrum/.env.example` sets `PORTAL_URL` to `https://portal.sqd.dev/datasets/arbitrum-one`. `ingestion/sources.json` has `arbitrum` / `erc20_transfers`. Staging is `transformation/models/staging/arbitrum/stg_arbitrum__erc20_transfers.sql`. The same package runs on Ethereum and Base. With `wallets` set, a run keeps transfers into or out of those wallets (`ingestion/sources/evm-erc20-transfers/src/source.ts`). Ethereum's list does not contain the pinned wallets. Its tokens are USDC, USDT and DAI. Arbitrum's `addresses.json` has no `wallets` key and one token, UNI `0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0`. The pinned addresses and the Arbitrum USDC receipts are not covered.

**Native ETH, top-level.** `evm-wallet-transactions` is the transactions source. It records top-level transactions sent from or to listed wallets, with `value`, `from` and `to` (`ingestion/sources/evm-wallet-transactions/src/source.ts`). That covers the ~160 ETH splits and the hop to `0x1231…4EaE` once those wallets are on the list. It does not record internal transfers. The ETH a CoW settlement pays is an internal call, so this source is not how a fill's ETH is read. The package has `chains/ethereum/` only. `START_BLOCK` is 26201365, which is before the cutoff window. Moving the package to Arbitrum would be a `chains/arbitrum/` folder plus staging, and no change to `source.ts`. This brief does not move it.

**CoW.** `evm-cow-ethflow` is Ethereum-only (`chains/ethereum/`, Portal `ethereum-mainnet`, `START_BLOCK` 21160715). It already decodes three logs. `OrderPlacement` is requested from Portal with `topic1` equal to the listed wallets, and `sender` is indexed, so path (b) below reuses that request. `Trade` is not requested on its own. It arrives only because the ERC-20 request sets `transactionLogs: true` and `topic2` to the listed wallets, which is a transfer *into* a listed wallet. `keptEvent` then keeps a settlement `Trade` that rode along (`source.ts`, the `Trade` branch and the comment on `blockRecords`). Listing the withdrawing wallet does not capture a fill that was paid in native ETH. The current wallet list is only `0x5CBC6299faB3320E7758ac97fd4CA45E5B722059`. Settlement and EthFlow addresses are already in `addresses.json`:

| Role | Address |
|---|---|
| GPv2Settlement | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` |
| CoW EthFlow | `0xba3cb449bd2b4adddbc894d8697f5170800eadec` |

`Trade.owner` is indexed (`catalog/protocols/cow-protocol/abis/gpv2-settlement.json`). `orderUid` is not indexed, so Portal cannot filter on it. `int_ethereum_cow_ethflow_orders` already builds the UID as `createOrder` output, the EthFlow address and `validTo`. `cow_ethflow_orders` already joins that UID to `Trade`. Its `received_amount` is 0 when the receiver is not a followed wallet, because those transfers are not loaded (`transformation/models/marts/cow/cow_ethflow_orders.sql`).

**Pool prices.** `evm-uniswap-v3` follows every pool of the tokens in `addresses.json`, as `token0` or `token1`. The Ethereum list is PEPE and UNI. There is no pool allowlist. Adding WETH and USDC would read every v3 pool of those tokens, not only `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640`. Config alone cannot target that pool. The factory cache path is a hash of the address file (`ingestion/lib/src/factory-cache.ts`). A run whose cache file is new and whose cursor is old fails on purpose (`source.ts`). `START_BLOCK` for swaps is 26093738.

**Candles.** `coinbase-candles` loads ETH against USD at `CANDLE_INTERVAL=1h` (`tokens.json` quote `USD`, tokens include `ETH`). `binance-candles` loads ETH against USDT at `1h`, not ETH against USD. Both already feed `analytics.token_prices`.

**Finality.** `portalClient` sets `finalized: true`, and `finalizedHead` reads Portal's finalized head (`ingestion/lib/src/portal.ts`). Every stream ends at `min(END_BLOCK, finalized head)`. The repo does not say how that head is defined on an L2.

**Cursor.** A new filter does not re-read blocks the cursor has passed. `docs/source-provenance.md` describes `SOURCE_BACKFILL_ID` for a new generation that keeps old rows. `README.md` says a changed wallet list keeps rows already loaded.

No new source is required for top-level native transfers. CoW capture and the pool read are changes to sources that exist. Internal ETH paid by a settlement is a new source, decided below. A separate Trade-only source stays the alternative under Open questions, and only if the EthFlow-owner request is too wide.

## Shared components

Build each of these once. Lighter is the first consumer. The two pending briefs are possible later consumers.

### 1. CoW fills: two capture paths

Owner of the filter: BJ Ingestion. Owner of the join and the checks: BJ Transform.

Both paths live in `evm-cow-ethflow`. One shared fix covers a stablecoin-to-ETH buy and an ETH-to-USDS EthFlow sale.

**(a) Direct orders.** Keep a GPv2 `Trade` when its indexed `owner` (`topic1`) is a listed wallet, whatever tokens move in the transaction. Add a Portal log request: settlement address, `topic0` = `Trade`, `topic1` = the listed wallets, with `transactionLogs: true` so the settlement's other logs come along. The Analyst confirmed this shape for every Lighter fill and for the whale fills: the payer is `Trade.owner`, and the settlement pays native ETH. The current into-wallet transfer filter misses that shape.

**(b) EthFlow orders.** On an EthFlow sale the `Trade` owner is the EthFlow contract `0xba3cb449bd2b4adddbc894d8697f5170800eadec`, not the user. An owner filter on `0x5CBC…2059` would miss its sales. Keep the existing `OrderPlacement` request, which already filters `sender` (`topic1`) to a listed wallet. Add a Portal log request for `Trade` with `topic1` equal to the EthFlow addresses in `addresses.json`. Transform joins `OrderPlacement` to `Trade` on the order UID, using the UID `int_ethereum_cow_ethflow_orders` already builds. A `Trade` owned by EthFlow with no matching placement is not a fill of a listed wallet.

Stop selecting `Trade` logs by "this transaction also transferred an ERC-20 into a listed wallet". Keep that transfer request: `int_ethereum_cow_wallet_transfers` and the existing payment leg use it. Also keep a `Transfer` that shares a transaction with a kept `Trade`, even when `to` is not a listed wallet, so a payment to another receiver is visible. Today `keptEvent` drops those logs.

`int_ethereum_cow_trades` today keeps every `Trade` that arrived, including other traders in the same settlement. After the change it keeps path (a) and path (b) only. `cow_ethflow_orders` must still resolve the EF wallet's own UID.

No fill is dropped for size. There is no 0.05 ETH minimum in this repo, and this work does not add one. The coverage check reports any excluded fill and the reason. The four whale fills that were dropped elsewhere for a 0.05 ETH minimum are in scope of the shared decoder when that card joins.

**Alternative, not the recommendation.** A separate Trade-only source keyed on owner. Use it only if Open question 3 says the EthFlow-owner request is too wide.

### 2. Native ETH transfers

Owner: BJ Ingestion for the wallet list and the backfill id. BJ Transform for the model an analyst queries.

`evm-wallet-transactions` is the shared source for top-level transfers. Records are top-level transactions with `value`, `from`, `to` and `status`. Internal calls stay out of it (`source.ts` says traces are the only place those show). The Lighter splits and the sends to `0x1231…4EaE` are top-level, so they are this source once the seed's `load = true` wallets are listed. The same source is what a later card would point at for its own wallets.

Native-ETH CoW fills are not in that source. The Analyst found that every such fill pays the payer by an internal call from GPv2Settlement, with zero fee: all six Lighter buys, and, in the whale trace, all 218 Voorhees fills and all 99 7 Siblings fills. There is no ERC-20 `Transfer` to reconcile, so `Trade.buyAmount` is unverified until a trace matches it.

**Decision.** BJ Ingestion builds a traces-based internal ETH transfer source, rated Medium, as the check on `Trade.buyAmount`. Portal already serves Ethereum traces. `evm-cow-ethflow` already calls `addTraceRequest`, but only for `createOrder` (`callFrom` the listed wallets, `callTo` EthFlow, `callSighash` `0x322bba21`). That request does not load settlement payouts. The new source stays on Portal, the same origin, and does not use RPC or archive reads. Archive balance reads of the receiver at the settlement block are rejected.

Scope is Ethereum first. Scaffold with `uv run --project orchestration bj new-source ethereum internal_eth_transfers --like evm-cow-ethflow`, which names the package `evm-internal-eth-transfers` and the raw table `ethereum_internal_eth_transfers`. The trace request is calls with `callFrom` GPv2Settlement and `callTo` the listed wallets, the same wallet set as `evm-cow-ethflow`. dbt keeps a successful call whose value is non-zero. A native fill is reconciled only when that call's value equals `Trade.buyAmount` and `feeAmount` is 0. Until the source is built, the coverage check labels these fills `checked against buyAmount only` and does not count them as reconciled.

Whether Portal serves Arbitrum traces is Open question 6. Do not add `chains/arbitrum/` on this source before that is answered.

### 3. One pool's hourly prices, with a candle cross-check

Owner: BJ Ingestion for the pool read. BJ Transform for the hourly model and the cross-check.

Add an optional `pools` list to `evm-uniswap-v3`. When it is set, request `Swap` logs for those pool addresses directly, from the chain's existing `START_BLOCK`, beside the factory path. Leave the factory cache and the PEPE/UNI generation alone. The list for this work is one pool: `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` (WETH/USDC 0.05% on Ethereum).

dbt builds one row per pool per UTC hour from those swaps: open, high, low, close, in USDC per WETH. The cross-check places that close beside `token_prices` for the same hour: Coinbase ETH-USD, and Binance ETH-USDT. The test fails when a candle is missing. It prints the gap. A numeric tolerance stays unset until Ian sets one. The Binance quote is USDT.

## Collection list

One seed, `lighter_drain_addresses`. `load = true` means the address goes on the ingestion wallet list named in the last column. `load = false` means the hop model may label the address, and no source lists it. Leads are labelled leads. `0x46f3…94b` was already sending ETH before it received these splits; it held 240.04 ETH at cutoff, not all from this trail.

The withdrawing wallet is `0xb3fffca23d4444eE73349825ACD84f7b5020e387`, the address named by 0xTria and by Lighter's update. After this sentence the plan calls it the withdrawing wallet.

| Address | Chain | Role | Load | List |
|---|---|---|---|---|
| `0xb3fffca23d4444ee73349825acd84f7b5020e387` | ethereum | withdrawing_wallet | true | erc20, wallet txs, cow wallets |
| `0x3b4d794a66304f130a4db8f2551b0070dfcf5ca7` | ethereum | lighter_l1 (ZkLighter) | false | label only. Listing it would pull every USDC transfer of the contract. The withdrawal is the incoming transfer of the withdrawing wallet. |
| `0x183ef7195d443a3da7ec1d7003baca1ff490757d` | ethereum | lighter_l1_messaging | false | context from Lighter's docs, not a hop |
| `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` | ethereum | token USDC | true as token | already in the Ethereum token list |
| `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2` | ethereum | token WETH | true as token | add to the Ethereum token list. Address from `catalog/protocols/uniswap/NOTES.md`. The one WETH fill. |
| `0x9008d19f58aabd9ed0d60971565aa8510560ab41` | ethereum | settlement | true as contract | already in cow `addresses.json` |
| `0xba3cb449bd2b4adddbc894d8697f5170800eadec` | ethereum | eth_flow | true as contract | already in cow `addresses.json`. Shared path (b), not a Lighter hop. |
| `0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae` | ethereum | eth_destination | false | Lookonchain label LiFi, attribution only. The twelve sends are outgoing txs of the split wallets. |
| `0x2df1c51e09aecf9cacb7bc98cb1742757f163df7` | arbitrum | bridge_deposit | false | Hyperliquid bridge, where the trace stops. Do not list it as a wallet: that pulls every depositor. |
| `0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640` | ethereum | price_pool | true as pool | the `pools` list, not the token list |

Twelve split wallets, role `split_traced`, `load = true`, on Ethereum wallet txs and ERC-20, and on Arbitrum ERC-20. Each sent 160 ETH to `0x1231…4EaE` and later deposited USDC to the bridge. The first four were also OnchainLens leads; the withdrawing wallet's own outgoing value is what pins them.

`0x63d09d9bd23c3ed507771db8bdd65bf557fe968c`, `0x5c239e7607975be5cf44ec71d2cf1c66d878f746`, `0x8b3a5786d4503faeffa78e30c31a57bfda93b121`, `0xd8427872a4e9ddf00ee07f02c644447aa6b99926`, `0xd1fd67c883466947e1f7dbf06f284cb2785b8c77`, `0x26f3cc7d0c4fa5566f33cdbf8569b96f11cfc74e`, `0xb57c2a0a4b20d7ec73395dc23fe182e9e6830ab1`, `0xed762776faa72631083f02b0dc91593426634c14`, `0x5f75b9a476d0012ffbb0af69bf43ddd03beb8bcd`, `0x2e10f4d519e3414fdf7a9baabdc396219276ddb4`, `0xb90f1af1fbe8c87e867be6966348309bf9fad8cd`, `0x64f909336976236d88cd2684c1ea3d59b57bb6db`.

| Address | Role | Load | Why |
|---|---|---|---|
| `0xf069c0aba66ce3ae3614e8653a8e154ddc20d6b1` | split_returned | true, Ethereum wallet txs | sent 160 ETH back to the withdrawing wallet |
| `0x3cf028769e0990c8f4c0618dce206a06cfb102fe` | split_returned | true, Ethereum wallet txs | sent 160 ETH back to the withdrawing wallet |
| `0x4a9c80e8e80f8ea5920f3e8b74f10651c5acbc22` | split_forwarder | true, Ethereum wallet txs | received 160 ETH, forwarded 159.90 ETH to `0x46f3…94b`, and kept ~0.10 ETH |
| `0x46f3fb8c14006268d153b18000495c8ee858e94b` | onward_recipient | false | Already sending ETH before it received these splits; held 240.04 ETH at cutoff, not all from this trail. Inbound ETH is visible from the senders, so the source does not list it. |
| `0x1cde1ae1114c01ce42c099c927d65e92bb0218a1` | split_untraced | true, Ethereum wallet txs | received 120 ETH and split it |
| `0xd90e2f925da726b50c4ed8d0fb90ad053324f31b` | split_untraced | false | 10 ETH from the 120 piece. No Hyperliquid deposit pinned. |
| `0x51649cf810ea9f1f61165044b7149070c67f79c8` | split_untraced | false | 100.000203 ETH from the 120 piece |
| `0x79fbfcb5fdf6e08ff93b199b4a72b930e9f65555` | split_untraced | false | 9.996752 ETH from the 120 piece |

Leads, `load = false`, role `lead`: `0xfd03abcadaf3f930fa4e37eb2f6ea3a44a41b7f0` (Across, attribution only), `0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f` (RelayRouter, attribution only), `0xccc88a9d1b4ed6b0eaba998850414b24f1c315be`, Arbitrum USDC payer `0x5b5c62f6140fdc5fc19105dccd89dfb1b4d66429`, gas funder `0xae06669dfd3e932476f00ea49fce82e5e63f83bf`. The payer does not need to be listed: the twelve recipients' incoming transfers cover the receipts.

Do not add whale wallets, and do not add further wallets, until a later card is approved. The cow wallet list gains the withdrawing wallet and keeps `0x5CBC…2059`.

## Schemas and grain

Addresses and hex are lowercase text. Amounts are base units in staging and whole tokens in the marts. The cutoff column is `2026-11-16 17:00:00+00`.

- **Seed `lighter_drain_addresses`.** One row per address: `address`, `chain`, `role`, `load`, `label` (`pinned` or `lead` or `attributed`), `note`.
- **Seed `lighter_drain_figures`.** One row per reported or open figure: `figure_id`, `claimed`, `observed`, `unit`, `status`. Status is `match`, `mismatch`, `open_at_cutoff`, `untraced` or `inferred`.
- **`int_ethereum_cow_fills`.** One row per fill of a listed wallet. `capture` is `direct_owner` or `ethflow_uid`. Columns include chain, block, tx, log index, owner, sell token, buy token, sell amount, buy amount, fee amount, order uid, and, from the transfers in that tx, payment receiver and payment amount. Grain key: `tx_hash` + `log_index`.
- **`int_ethereum_wallet_native_transfers`.** One successful top-level transaction with a non-zero `value`, from or to a wallet the source follows. Shared. The Lighter hop model filters it to the seed and the cutoff.
- **`int_ethereum_uniswap_v3_pool_hours`.** One row per pool per UTC hour for pools on the `pools` list.
- **Mart `lighter_hops`.** One movement: `chain`, `block_number`, `block_timestamp`, `tx_hash`, `log_index` (null for a native tx), `from_address`, `to_address`, `asset`, `amount`, `hop_kind` (`erc20`, `native_top_level`, `cow_fill`, `inferred_link`), `inferred` (true only for the cross-chain link), `open_at_cutoff`.
- **Mart `lighter_reconciliation`.** One row per figure id, the claimed value, the observed value, the delta, and the status. A mismatch is a row, not a hidden filter.

The inferred link is one row per `split_traced` wallet that has an Ethereum send of 160 ETH to `0x1231…4EaE` and an Arbitrum USDC transfer to the Hyperliquid bridge. The USDC amount is the bridge deposit. A wallet with no such pair stays `open_at_cutoff`.

## Reconciliation figures

These are the rows in `lighter_drain_figures`. The test expects these statuses. A pipeline that forces the ~5.4k claim to match fails the test.

| figure_id | Observed at the cutoff | Status |
|---|---|---|
| `usdc_withdrawal` | 10,393,056.79 USDC, one `Transfer` from ZkLighter, tx `0x5b6f27ded0e9a66ef6fa107083e28db9914e46d7635cc5112d760b9cb2f958c9`, block 26426910. Trace amount 10,393,056.789298. | match to the reported $10.39M withdrawal |
| `eth_bought` | 5,764.470028 ETH from `Trade.buyAmount` across six fills, for 10,383,182.629682 USDC. Implied 1,801.2380 USDC per ETH on those fills. `feeAmount` is 0 on all six. Each fill pays the payer by an internal call, so this sum is `checked against buyAmount only` until the trace source matches call value to `buyAmount`. | mismatch against the ~5.4k claim (+364.47 ETH). The mismatch is the finding. The row is not reconciled. |
| `gross_eth_out` | 2,680.0002 ETH | match to the trace. The 320 ETH that later returned is part of this gross outflow. |
| `net_eth_out` | 2,360.0002 ETH | match to the trace. Net = 1,920 ETH traced + 440.0002 ETH untraced. The 320 ETH that returned is part of the gross, not this net. |
| `traced_to_bridge_eth` | 1,920 ETH, twelve wallets | match |
| `traced_to_bridge_usdc` | 3,463,084.19 USDC (trace total 3,463,084.192549) deposited to the Hyperliquid bridge | match |
| `traced_usdc_per_eth` | 1,803.69 USDC per ETH | applies to those twelve wallets only |
| `untraced_eth` | 440.0002 ETH | open at cutoff. Two 160 ETH pieces were sent toward `0x46f3…94b` (one direct, 160.0002 ETH; one via `0x4a9c…`, which forwarded 159.90 ETH and kept ~0.10), plus the 120 ETH piece split on Ethereum into 100 / 10 / 10 across three addresses. None of these is pinned to a Hyperliquid deposit. |
| `returned_eth` | 320 ETH, two 160 ETH pieces, from `0xf069…d6b1` and `0x3cf0…02fe`, back to the withdrawing wallet | part of the 2,680.0002 ETH gross outflow, not the 2,360.0002 ETH net. The withdrawing wallet held 3,404.55 ETH at the cutoff. |
| `withdrawing_wallet_eth` | 3,404.55 ETH (trace 3,404.545987) | open at cutoff |
| `onward_recipient_eth` | `0x46f3…94b` held 240.04 ETH (trace 240.043141) | open at cutoff. Already sending ETH before it received these splits; held 240.04 ETH at cutoff, not all from this trail. |
| `untraced_reported_gap` | 0xTria's rounded $15.5M total minus the 10,393,056.79 USDC withdrawal | untraced. No location. |

One-off tie-out, not a pipeline gate: 2,360.0002 ETH net out plus 3,404.55 ETH remaining on the withdrawing wallet lands within 0.08 ETH of the 5,764.47 bought. It corroborates `buyAmount` for this trail. It does not mark the six fills reconciled, and the coverage check does not read it.

Fixture amounts for the 440.0002 ETH untraced piece of the net, from the trace: direct 160.000203 ETH toward `0x46f3…94b` in `0x31446169c31cd03e74375dba028c2af1964613dab9ed82282ac81f6d9612a27a`; the other 160 ETH went via `0x4a9c…`, which forwarded 159.900203 ETH in `0x9846edd33780c5f62c2c68e87f5d4361ad66cb93b4f1337dad7ded2d22948876` and kept ~0.10 ETH; the 120 ETH children are 100.000203, 10 and 9.996752 ETH. The headline group is 100 / 10 / 10. The 320 ETH that returned is part of the 2,680.0002 ETH gross, not this 440.0002. Those return txs are `0x390b72c0723a631e4f3c8a4d1c3fcdfca4db0a5c33f476c0aa4d6febd3b14906` and `0x7b8fc6110469595d485ccebd40d0bcab268c6413afb1e65edf473581d16e85d4`.

The twelve bridge deposits, sum 3,463,084.192549 USDC:

| UTC | Tx | From | USDC |
|---|---|---|---|
| 10:37:56 | `0x085880a73267ea649ad74ef6be6aaa632b5db2b2b1a3c33ae390a21a7626dadd` | `0x5c239e…f746` | 287,771.286219 |
| 10:39:25 | `0x096e70da983a31949c49ef31f1c279b588c2e6c74a790f7fa217185f890a3549` | `0x63d09d…968c` | 287,557.554800 |
| 10:57:12 | `0xa9f37ce1bb4ed0ebcda482ec6a7186f32629b3847ee566bdc0a66ab836d6ebb3` | `0xd84278…9926` | 288,300.930806 |
| 10:58:10 | `0xbb0a9ee1d566f5b3ac80a59b45f27616a8c31e2d354916f5b8877991480913c7` | `0x8b3a57…b121` | 288,517.696936 |
| 11:16:38 | `0x13073003223a235ef6a03980d207a420fe1a60801dcde0e467f9c3b1647e0bd4` | `0xd1fd67…8c77` | 288,851.349851 |
| 11:17:24 | `0x70d6b31d1616b26072660156f78e5c5abb3829eeebaa09397401dfad840745d7` | `0x26f3cc…c74e` | 288,540.933768 |
| 11:35:57 | `0x8a2c811980c80b833a0c14858758fc45eba001343bd900903ea234b75b4423dd` | `0xb57c2a…0ab1` | 289,411.566275 |
| 11:36:34 | `0x8c0cdf5ff4551237069fc88722bcc17eb638026922311d48c9caab367586ba91` | `0xed7627…4c14` | 289,250.146548 |
| 11:55:10 | `0xdd59ac1cc8cb94681e388f4f10e20c25a910e4df84dfcf8e951c928be0f76f67` | `0x5f75b9…8bcd` | 288,866.296213 |
| 11:55:59 | `0x818329fec35647e306050322df565ec5536744c258f2fd325e51d11c395771b1` | `0x2e10f4…ddb4` | 288,639.970599 |
| 12:13:34 | `0x0da06354825e3ff233dbdc6c7f7351b6f796d48ca8c66d344e83a888ba556517` | `0xb90f1a…d8cd` | 288,766.563151 |
| 12:15:10 | `0xdc816e825bfd7b851e900adcefde539e5cf21d80cbe2bc1c81b06acd563d1a4f` | `0x64f909…b6db` | 288,609.897383 |

## Dependencies

The hop mart reads the shared fill model, `stg_ethereum__wallet_transactions`, `stg_ethereum__erc20_transfers` and `stg_arbitrum__erc20_transfers`, and the address seed. The fill model reads `stg_ethereum__cow_ethflow` and `stg_ethereum__cow_ethflow_traces`. Once the internal-transfer source exists, the native-fill check also reads `stg_ethereum__internal_eth_transfers`. The hour model reads `stg_ethereum__uniswap_v3`. The cross-check reads `token_prices`. The internal-transfer source is the new package. Catalog scope text for CoW is updated in the same change as the filter, because `protocol.yaml` currently says ordinary signed orders are not loaded.

## Phased changes

### Phase 1. BJ Ingestion

Files:

- `ingestion/sources/evm-cow-ethflow/src/source.ts` and `src/source.test.ts`. Paths (a) and (b). Keep `OrderPlacement` and the into-wallet `Transfer` request. Keep transfers that share a tx with a kept `Trade`.
- `ingestion/sources/evm-cow-ethflow/chains/ethereum/addresses.json`. Add the withdrawing wallet. Leave the EF wallet.
- `catalog/protocols/cow-protocol/protocol.yaml` and `NOTES.md`. Record path (a), and that path (b)'s `Trade` owner is the EthFlow contract. One proof row from the six settlements, plus the existing EF proof row.
- `ingestion/sources/evm-internal-eth-transfers/` (new, Medium, Ethereum only). `uv run --project orchestration bj new-source ethereum internal_eth_transfers --like evm-cow-ethflow`, then a trace request for calls from GPv2Settlement to the listed wallets. `src/source.test.ts` fixtures: one internal call per Lighter native fill, value equal to that fill's `buyAmount`, `from` the settlement, `to` the withdrawing wallet, fee zero. The whale-shaped fill gets the same shape. Wallet list matches `evm-cow-ethflow`.
- `ingestion/sources/evm-wallet-transactions/chains/ethereum/addresses.json`. Add every seed row with `load = true` on Ethereum wallet txs.
- `ingestion/sources/evm-erc20-transfers/chains/ethereum/addresses.json`. Same wallets. Add WETH.
- `ingestion/sources/evm-erc20-transfers/chains/arbitrum/addresses.json`. Add the twelve `split_traced` wallets. Add the Arbitrum USDC token after Open question 2 is answered. Until then the Arbitrum list is unfinished.
- `ingestion/sources/evm-uniswap-v3/src/source.ts`, `src/source.test.ts`, and `chains/ethereum/addresses.json`. Optional `pools` list and a direct `Swap` request. Do not put WETH or USDC on the token list for this purpose.
- `ingestion/sources.json`, only if `pnpm generate-sources` changes coverage. A new wallet on an existing chain does not add a row.

Each changed source gets its own `SOURCE_BACKFILL_ID` when Ian approves the load (`docs/source-provenance.md`). Do not commit `END_BLOCK` into the shared examples. Do not start the load in this work.

### Phase 2. BJ Transform

Files:

- `transformation/models/staging/ethereum/stg_ethereum__cow_ethflow.sql`. The header comment still says a `Trade` is kept only when the tx transferred an ERC-20 into a followed wallet. Update the comment to the two paths. The column list already has `trade_owner`, `trade_order_uid` and the transfer columns.
- `transformation/models/staging/ethereum/stg_ethereum__internal_eth_transfers.sql`. The `bj new-source` stub. One successful value-bearing call: block, tx, trace address, from, to, value. BJ Transform owns the check that joins it to `buyAmount`. BJ Ingestion owns the source.
- `transformation/models/intermediate/cow/int_ethereum_cow_fills.sql` and a unit test in `_int_cow__models.yml`. The UID join, the direct-owner path, and the payment check.
- `transformation/models/intermediate/cow/int_ethereum_cow_trades.sql`. Keep path (a) and path (b) only, so `cow_ethflow_orders` still joins the EF UID and no longer keeps other traders' trades from the same settlement.
- `transformation/models/intermediate/accounts/int_ethereum_wallet_native_transfers.sql`, or the equivalent under the folder the `accounts` pipeline already uses. One successful top-level native transfer.
- `transformation/models/intermediate/dex/int_ethereum_uniswap_v3_pool_hours.sql`.
- `transformation/seeds/lighter_drain_addresses.csv`, `transformation/seeds/lighter_drain_figures.csv`, and `transformation/seeds/_seeds.yml`.
- `transformation/models/marts/lighter/lighter_hops.sql` and `lighter_reconciliation.sql`, plus `_lighter__models.yml`. Tag the models so Phase 3 can keep them off `daily`.
- `transformation/tests/lighter_drain_fills_cover_pinned.sql` and `transformation/tests/lighter_drain_reconciliation_matches_figures.sql`.
- `transformation/analyses/lighter_drain.sql`. One result an analyst can rerun.
- `answers/lighter-drain/answer.md`. Written after a load exists. This plan does not write the answer.

An ERC-20 fill compares `buyAmount` with the transfers of the buy token in the same settlement tx. A payment to a different receiver is a flagged column, not a silent 0. A native-ETH fill has no ERC-20 `Transfer` to reconcile. The buy token on the six Lighter `Trade` logs includes the native sentinel (the editorial trace writes it `0xeee…`; the full address is not in the repo, so the fixture copies it from the pinned log) and one WETH fill of 1,109.432165 whose payout to the payer is still the internal call. Until `stg_ethereum__internal_eth_transfers` is loaded, each of those fills is labeled `checked against buyAmount only` and is not reconciled. After it is loaded, Transform reconciles a fill only when a successful call from GPv2Settlement to the payer in that tx has value equal to `buyAmount` and `feeAmount` is 0.

The six Lighter `buyAmount`s sum to the `eth_bought` figure. That sum is the reported-figure mismatch. It is not a reconciled payout.

### Phase 3. BJ Orchestration

`daily` in `orchestration/pipeline/schedules.py` selects `path:models/marts` and is scheduled at 06:00 UTC. A new `marts/lighter/` folder would load with everything else. BJ Orchestration changes that selection so the lighter marts stay out until Ian approves the load, and does not add `lighter` to `PIPELINES` before then. No run is launched.

## Gates

- **Finality.** Streams already request Portal's finalized head. Ethereum rows in the marts have `block_number <= 26428942`. Arbitrum rows have `block_number <= 524806268`. Open question 1 is a gate on the Arbitrum load: until Ingestion records what the finalized head means on `arbitrum-one`, the Arbitrum hops are loaded and labelled with that open question, and the reconciliation does not call them finalized beyond what the trace already checked.
- **Cutoff.** Marts drop rows after 2026-11-16 17:00:00 UTC. The seed is not extended after that time.
- **Decoding coverage.** For the withdrawing wallet, decoded fills equal the six pinned settlements. The check lists any pinned tx that is missing, and any extra fill, with a reason. It has no size threshold. A threshold added later has to appear in that list or the check fails. Each native-ETH fill is labeled `checked against buyAmount only` until the internal-call value matches `buyAmount`. The check never counts that label as reconciled. The one-off balance tie-out is not an input to this gate.
- **Reconciliation.** The mart's statuses equal the table above. The ~5.4k gap is a `mismatch` row. Gross outflow is 2,680.0002 ETH, and the 320 ETH that returned is part of that gross. Net outflow is 2,360.0002 ETH, equal to 1,920 ETH traced plus 440.0002 ETH untraced. The 440.0002 ETH, the 3,404.55 ETH and the 240.04 ETH are `open_at_cutoff`. The reported-total gap is `untraced`. The twelve bridge deposits are `match`, and the cross-chain link is `inferred`.
- **Backfill.** No `SOURCE_BACKFILL_ID` is started until Ian says go.

## Tests

Decoder fixtures in `source.test.ts`, against a fake Portal, the way the package already tests:

- **Path (a), six Lighter settlements.** A `Trade` whose `topic1` is the withdrawing wallet, with no ERC-20 `Transfer` into that wallet, is still a record. The six txs: `0x0c4792dc149b597582f4fd05a7941303e1293d3821f2787aded600ae33179cb6` (1,000,000 USDC to 555.707957 ETH), `0x3b0c442b8826dc2dc940b9e5695d078332f3b3ac90c373aa99be20b2852b3d5b` (2,000,000 to 1,111.261666 ETH), `0x2a5f6efd130af6900596069b4a48c74c0e1b1dc5742577482e42c59a590060d2` (5,000,000 to 2,775.366778 ETH), `0x2470732faf5b293e62f77cd7c4167733c9f6a097c1f4ec8e8b495bd12373fffd` (2,000,000 to 1,109.432165 WETH on the `Trade`, paid to the payer by an internal call), `0xc3f01db1cccc9e2c446e2e583ab2497d3f7628a0d9e1964126a877e9b1fdf200` (360,000 to 199.865360 ETH), `0x0e22e5c723e4f6384d1f815eece9cf84a6e44da69b8e8092fa003d1528cd2958` (23,182.629682 to 12.836103 ETH). The trace-source fixture has one successful call from `0x9008…ab41` to the withdrawing wallet per fill, value equal to `buyAmount`, fee zero. The dbt coverage row for each is `checked against buyAmount only` until that call is loaded, and `reconciled` only after the values match.
- **Path (a), one whale-shaped fill.** Same shape: owner is a listed wallet, payment is an internal call from the settlement, no ERC-20 transfer into that wallet, and the `Trade` record is kept. The whale trace's 218 Voorhees fills and 99 7 Siblings fills pay the same way, including fills under 0.05 ETH, so the shared decoder and the trace source keep those too. No whale tx hash is pinned in this brief. The real hash is added to the fixture when that card is approved. The test uses that shape, includes a fill under 0.05 ETH, and labels it `checked against buyAmount only`.
- **Path (b), one EF sale.** The proof row already in `catalog/protocols/cow-protocol/NOTES.md`: `OrderPlacement` in `0x53ed2e9588f6ac402cb07bf83b230e57cd29ab788bb102d829940638dabefe36` (block 26380868, sender `0x5cbc6299fab3320e7758ac97fd4ca45e5b722059`) and `Trade` in `0x4ccf0d2c0ee097dd9912fa37935e8dddfcd76eeab87615fd4b3a6dda636c48b3` (block 26380873, owner `0xba3cb449bd2b4adddbc894d8697f5170800eadec`). The source test shows both logs become records. The dbt unit test joins them on the UID and shows that an owner filter on the EF wallet alone would drop the `Trade`. A `Trade` owned by EthFlow with no matching `OrderPlacement` is not a fill.

dbt tests:

- The payment check flags an ERC-20 fill whose buy-token transfer in the same tx pays a different receiver.
- A native-ETH fill has no ERC-20 leg. Before the trace source is loaded it is `checked against buyAmount only` and is not reconciled. Afterward it is reconciled only when the internal call value equals `buyAmount` and the fee is 0.
- Coverage: the six txs are present for the withdrawing wallet, the count is six, and any exclusion carries a reason. The one-off tie-out (2,360.0002 net out + 3,404.55 remaining, within 0.08 ETH of 5,764.47) is not asserted here.
- Reconciliation statuses match `lighter_drain_figures`, using the `reference_mismatches` pattern in `transformation/macros/reference_mismatches.sql`.
- The pool-hour cross-check fails on a missing Coinbase ETH-USD hour or a missing Binance ETH-USDT hour, and shows both quotes.

## Analyst UX

After Ian approves a load, an analyst reads `analytics.lighter_hops` ordered by `block_timestamp`, `chain`, `log_index`, and `analytics.lighter_reconciliation` for the statuses. The schema default is `analytics` (`transformation/profiles.yml`). The address seed is the whole wallet list, so a second run with the same seed and the same cutoff reproduces the trail. `answers/lighter-drain/answer.md` states the question, the cutoff, the mismatch on the ~5.4k claim, the open rows, the untraced reported gap, and that the six native-ETH fills are `checked against buyAmount only` until the internal-call check matches. It points at `transformation/analyses/lighter_drain.sql`.

Shared models an analyst can use without the Lighter marts: `int_ethereum_cow_fills`, `int_ethereum_wallet_native_transfers`, `int_ethereum_uniswap_v3_pool_hours`, and `token_prices`.

## Risks and unresolved decisions

- A cursor that has already passed 16 Nov 2026 will not pick up the new `Trade` request. The six fills stay missing until a backfill id is run. That run waits for Ian.
- Committing `END_BLOCK` at the cutoff on a shared source would stop later history for the EF wallet and for PEPE/UNI. The cutoff lives in the Lighter models.
- Listing ZkLighter or the Hyperliquid bridge as a wallet pulls transfers outside this trail. Listing `0x46f3…94b` would also load ETH it was already sending before it received these splits. The seed marks all three `load = false`. The 240.04 ETH it held at cutoff is not all from this trail.
- `cow_ethflow_orders.received_amount` is 0 when the receiver was not followed. The new check flags that case. Implementers leave the old 0 in place only for orders the new check also flags.
- The 0.05% WETH/USDC pool is busy. The reference-seed example in `transformation/seeds/reference/README.md` uses this pool. The first approved load uses `MAX_BLOCKS_PER_RUN` as `docs/source-provenance.md` describes.
- Candle tolerance is unset. The cross-check reports the gap and fails only when a candle is missing, until Ian sets a tolerance.
- The cross-chain link can attach the wrong receipt if a split wallet has another USDC transfer to the bridge in the window. The link requires both pinned legs, and it stays `inferred`.
- Archive balance reads are rejected. They are not a fallback if the trace source is late. Until that source is built, native-ETH fills stay `checked against buyAmount only`.

## Open questions for BJ Ingestion

1. **L2 finality.** `portalClient` asks for finalized blocks. Nothing in the repo says how Portal defines the finalized head on `arbitrum-one`. Record that before an Arbitrum load is treated as finalized-blocks-only. This is a gate.
2. **Arbitrum USDC contract.** The trace does not name it. `chains/arbitrum/addresses.json` lists only UNI. Pin the contract from the receipt logs before adding the token. Do not guess it.
3. **Width of path (b).** `orderUid` is not indexed, so the EthFlow `Trade` request is every `Trade` whose owner is `0xba3cb449bd2b4adddbc894d8697f5170800eadec`, from `START_BLOCK` 21160715. Count those logs over the editorial window and from that start block before the first load. If the count is too wide, the alternative is a separate Trade-only source with its own start. The recommendation stays the two paths in `evm-cow-ethflow`.
4. **Factory cache.** The direct `pools` request is meant to leave `chains/ethereum/factory.sqlite` and its cursor alone. Confirm the cache hash does not change when `pools` is added, or give that request its own backfill id without rebuilding the PEPE/UNI generation.
5. **Backfill ids.** Confirm one `SOURCE_BACKFILL_ID` per changed source, and that `bj coverage` shows the new generation, when a load is approved. No load is part of this plan.
6. **Arbitrum traces.** The internal-transfer source is Ethereum first. `evm-cow-ethflow` and `evm-contract-deployments` already request traces on Ethereum, and the Polymarket notes record Portal traces for `polygon-mainnet`. Nothing in the repo requests traces for `arbitrum-one`. Ingestion confirms whether Portal serves them before any Arbitrum trace source is added. This trail's Arbitrum hops are ERC-20 transfers, so they do not wait on that answer.
