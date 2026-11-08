# Polymarket on Polygon, CTF era: notes

These notes cover the CTF-era events in `protocol.yaml`: ConditionalTokens, the NegRiskAdapter, CTF Exchange v2, and the pUSD adapters and auto-redeemers between users and those contracts. Every address, block, topic and field meaning comes from SQD Portal data for `polygon-mainnet`, from `eth_call` reads on `https://polygon.drpc.org`, from Polymarket's GitHub repos, or from Sourcify-verified sources, as `protocol.yaml` lists. Facts that would come from Gamma come from Dune's `polymarket_polygon.market_details` and Polymarket's client code instead, since `*.polymarket.com` does not resolve here. Each such fact says "not proven on a Gamma reply". The proof table ties each event to real logs; later tasks cite its rows by number.

## How money and positions move

Every CTF-era position is an ERC-1155 token on ConditionalTokens. Its id derives from a collateral token, a condition id and an index set:

```
collectionId = ConditionalTokens.getCollectionId(0x0, conditionId, indexSet)
positionId   = ConditionalTokens.getPositionId(collateral, collectionId)
```

The collateral is USDC.e for binary markets and the NegRiskAdapter's `wrapped_collateral` for neg-risk markets, even though users now pay in pUSD. pUSD wraps USDC.e 1:1; every proof row moves the USDC.e between pUSD's vault (`0xc417fd8e9661c0d2120b64a04bb3278c17e99db1`) and the contract that needs it. All amounts, collateral and shares alike, have 6 decimals.

Users reach ConditionalTokens in five ways in the window. Each way names the user in exactly one event:

| Path | Contracts in the chain of calls | The event that names the user | Proof rows |
|---|---|---|---|
| Trade on an exchange | exchange, then for a mint or merge an old adapter, ConditionalTokens (and the NegRiskAdapter) | `ctf_exchange_v2.OrderFilled` (`maker`) | 1, 2, 3, 10, 11, 17 |
| Split, merge, redeem or convert with pUSD through a current adapter | `ctf_collateral_adapter` or `neg_risk_ctf_collateral_adapter`, then (NegRiskAdapter and) ConditionalTokens | `collateral_adapter.*` (`initiator`) | 4, 5, 12, 13, 16 |
| Redeem through an auto-redeemer | `ctf_auto_redeem` or `auto_redeemer`, then (NegRiskAdapter and) ConditionalTokens | `auto_redeemer.BinaryRedemption` or `NegRiskRedemption` (`from`) | 7, 14, 15 |
| Call the NegRiskAdapter directly | NegRiskAdapter, then ConditionalTokens | `neg_risk.*` (`stakeholder` or `redeemer`) | 8 |
| Call ConditionalTokens directly, with USDC.e or wrapped collateral | ConditionalTokens | `ctf.*` (`stakeholder` or `redeemer`) | 6 |

A sixth way exists but names nobody: users still call the old binary adapter (`ctf_collateral_adapter_v1`) to merge or redeem. Q5 below gives the numbers and two ways to name them.

Every event further down the chain names the contract above it, not the user. In row 16 a user splits through `neg_risk_ctf_collateral_adapter`: ConditionalTokens' `PositionSplit` names the NegRiskAdapter, the NegRiskAdapter's `PositionSplit` names the adapter, and only the adapter's `PositionSplit` names the user.

## `OrderFilled` fields

`OrderFilled(orderHash, maker, taker, side, tokenId, makerAmountFilled, takerAmountFilled, fee, builder, metadata)`. All three v2 exchanges declare it in `ITrading.sol` and emit it from `Events.sol`.

| Field | Where | Meaning |
|---|---|---|
| `orderHash` | topic1 | The EIP-712 hash of the filled order. |
| `maker` | topic2 | The order's owner: the wallet whose pUSD or shares moved. A proxy wallet or Safe for most users. |
| `taker` | topic3 | The owner of the match's taker order, or the exchange itself on the taker order's own fill (Q2). |
| `side` | data word 0 | 0 = buy, 1 = sell, for the order's maker. |
| `tokenId` | data word 1 | The position id the order buys or sells. |
| `makerAmountFilled` | data word 2 | What the maker gave: pUSD for a buy, shares for a sell. Before fees. |
| `takerAmountFilled` | data word 3 | What the maker got: shares for a buy, pUSD for a sell. Before fees. |
| `fee` | data word 4 | The maker's fee, in pUSD base units. |
| `builder`, `metadata` | data words 5, 6 | Order fields: the builder code that marks where the order came from, and a hash of order metadata. Zero in most proof rows. |

So for any fill, `usdc` is `makerAmountFilled` when `side` = 0 and `takerAmountFilled` when `side` = 1, `shares` is the other one, and `price = usdc / shares`.

### Fees

Fees are in pUSD. A buyer pays the fee on top of `usdc`; a seller has it taken from `usdc`. Both makers and takers can pay one (row 10). The exchange emits a `FeeCharged(receiver, amount)` for each and sends the pUSD to `fee_receiver`. On 2026-11-07 `getMaxFeeRate()` returned 0 (no cap) on `ctf_exchange_v2` and `neg_risk_ctf_exchange_v2`, and 500 on the retired exchange. Row 10 shows a taker fee of 4.94% of `usdc`, on a trade at price 0.011.

### Match types

The operator matches one taker order against one or more maker orders in one transaction. `Trading.sol` picks the match type per maker order:

- Complementary: one buys and one sells the same `tokenId`. Shares and pUSD move between the two wallets (rows 1, 10, 11, 17).
- Mint: both buy, on the two outcomes of one condition. The exchange pulls both buyers' pUSD, splits it through its old adapter into one share of each outcome per pUSD, and hands each buyer its outcome. The two prices add up to 1 (row 2: 0.51 + 0.49).
- Merge: both sell, on the two outcomes. The exchange merges the shares through its old adapter and pays each seller. The two prices add up to 1 (row 3: 0.95 + 0.05).

One match can mix types (a taker buy against one maker buy and one maker sell). Each maker order still gets its own `OrderFilled`.

The exchanges never appear as a ConditionalTokens or NegRiskAdapter stakeholder. Their mints and merges run through their immutable `getOutcomeTokenFactory()`, the old adapters, so those adapters are the stakeholders (rows 2 and 3). The plan's "What we know" says the exchange itself shows up; the chain says the adapter does.

## Answers to Q1–Q7

### Q1. Which asset each amount counts, and how the fee is paid

For a buy, `makerAmountFilled` is pUSD paid and `takerAmountFilled` is shares received. For a sell, `makerAmountFilled` is shares given and `takerAmountFilled` is pUSD received. Both are before fees. A buyer pays the fee on top; a seller has it taken from the proceeds. Checked against pUSD and ConditionalTokens transfers in rows 1, 2, 3, 10 and 11:

- Row 1, taker buy: 4,800,000 pUSD to the seller (log 402) plus 20,160 fee (log 407) left the buyer: 4,820,160 in all.
- Row 2, taker buy in a mint: the buyer sent 4,420,260 pUSD = 4,267,900 + 152,360 fee (log 85).
- Row 3, taker sell in a merge: the seller got 212,890 = 223,500 − 10,610 fee (log 660).
- Row 10, maker sell: the seller got 5,497,250 = 5,500,000 − 2,750 fee (log 332). The taker buyer paid 5,500,000 + 271,970.
- Row 11, taker sell: the seller got 3,581,020 = 3,650,000 − 68,980 fee (log 80).

### Q2. The taker order's fill names the exchange

On every match the exchange emits one `OrderFilled` per maker order, with `taker` = the taker order's owner, then one for the taker order with `taker` = the exchange's own address, followed by `OrdersMatched` with the same order hash. Proof: rows 1, 2, 3, 10 and 11 on `ctf_exchange_v2` and row 17 on `neg_risk_ctf_exchange_v2`. Over blocks 96924000–96924999, `ctf_exchange_v2` sent 19,236 match transactions and `neg_risk_ctf_exchange_v2` 5,487. Each had exactly one `OrderFilled` with `taker` = the exchange, and its `orderHash` equalled the `OrdersMatched.takerOrderHash`. No maker fill named the exchange.

`neg_risk_ctf_exchange_v2_retired` never filled an order: all 92 of its logs (Dune `polygon.logs`, checked 2026-11-07) are one `NewAdmin` and 91 `NewOperator`, in blocks 84934480–85032699. Its code is the same `CTFExchange.sol`, so the rule would hold, but no log proves it.

In a complementary match the taker fill repeats the maker fills' volume on the same token. In a mint or merge the taker fill is on the other outcome: in row 2 the maker fill buys 8,710,000 Down at 0.51 and the taker fill buys 8,710,000 Up at 0.49. Either way it is one trade, and the maker fill alone prices both outcomes.

### Q3. No token registry on v2

The v2 exchanges emit no token registry event. `exchangeV2Abi` has no `TokenRegistered`, the ctf-exchange-v2 README lists "Registry — Token registration removed", and the three window samples hold no v2 log other than `OrderFilled`, `OrdersMatched` and `FeeCharged`.

`ctf_exchange_v1` still emits `TokenRegistered(token0, token1, conditionId)` in the window: about 228 logs per 2,000 blocks, two per market (48 `registerToken` transactions in blocks 96925000–96925999, all from `0xbaff6cfecfcb282e9177f1fff9047be7321851d7`). That covers only some binary markets: ConditionalTokens prepared about 2,600 conditions per 2,000 blocks in the same samples. So token to condition comes from Gamma. The position id formula above can check a Gamma row on chain, as rows 2, 8 and 9 do, but Postgres has no keccak, so dbt cannot derive ids itself.

### Q4. Polymarket contracts that act as stakeholder or redeemer

Over blocks 96924000–96925999, these Polymarket contracts were the `stakeholder` or `redeemer` of ConditionalTokens or NegRiskAdapter events. Each acts for someone else, so its own split, merge or redemption must be dropped from the wallet ledger; the event in the "named by" column carries the real actor. These rows become the `polymarket_contracts` seed.

| Contract | Address | Acts as | Count in the 2,000 blocks | Real actor named by |
|---|---|---|---|---|
| `ctf_collateral_adapter_v1` | `0xada100874d00e3331d00f2007a9c336a65009718` | CTF stakeholder of binary mints (34,719) and merges (1,262), redeemer (47) | 36,028 | the fills; for direct user calls, nothing (Q5) |
| `neg_risk_ctf_collateral_adapter_v1` | `0xada200001000ef00d07553cee7006808f895c6f1` | NegRiskAdapter stakeholder of neg-risk mints (5,571) and merges (292) | 5,863 | the fills |
| `ctf_collateral_adapter` | `0xada100db00ca00073811820692005400218fce1f` | CTF stakeholder and redeemer for users | 12,047 | `collateral_adapter.*` |
| `neg_risk_ctf_collateral_adapter` | `0xada2005600dec949baf300f4c6120000bdb6eaab` | NegRiskAdapter stakeholder and redeemer for users | 3,524 | `collateral_adapter.*` |
| `neg_risk_adapter` | `0xd91e80cf2e7be2e162c6513ced06f1dd0da35296` | CTF stakeholder and redeemer of every neg-risk action | 14,947 | `neg_risk.*` |
| `ctf_auto_redeem` | `0xf3cfb6a6ebfeb51876289eb235719eb1c65252b0` | CTF and NegRiskAdapter redeemer | 709 | `auto_redeemer.*` |
| `auto_redeemer` | `0xa1200000d0002264c9a1698e001292d00e1b00af` | CTF and NegRiskAdapter redeemer | 12,744 | `auto_redeemer.*` |
| `binary_module` | `0x1000008dd9001b968442c1000017eae6e0da00ba` | CTF redeemer of migrated positions | 2,886 | Protocol V2 events (Task 11) |
| `neg_risk_module` | `0x200000900045e3b6259600682756002200028933` | CTF redeemer of migrated positions | 625 | Protocol V2 events (Task 11) |

The v2 exchanges never appear. The v1 exchanges did not appear in the window samples. Every other actor in those 2,000 blocks was a wallet or a contract outside Polymarket: 162 other addresses as CTF redeemer, 90 as CTF merger, 5 as CTF splitter, and a few dozen calling the NegRiskAdapter directly.

ConditionalTokens also records splits and redemptions on collateral other than USDC.e and wrapped collateral. In the same 2,000 blocks: 49 splits and 43 merges with pUSD as collateral, and 1,967 zero-payout redemptions with pUSD as collateral by one contract (`0xe7c65c210add40c321c0da2a1d9fed4587142b25`, not verified, no owner). Their position ids are not Polymarket tokens. dbt keeps only USDC.e and wrapped-collateral rows.

### Q5. Which event names the wallet behind the pUSD adapters

pUSD's `RolesUpdated` logs (Dune `polygon.logs`, from the pUSD deploy to 2026-11-07) gave the wrapper role to seven contracts: the onramp, the offramp, PermissionedRamp, and the four adapters. None lost it. Two generations of adapters exist:

- The old ones, `ctf_collateral_adapter_v1` and `neg_risk_ctf_collateral_adapter_v1`, deployed 2026-03-31, emit no position events (their verified ABIs hold only ownership, role and pause events). The exchanges mint and merge through them, and users can still call them.
- The current ones, `ctf_collateral_adapter` and `neg_risk_ctf_collateral_adapter`, deployed 2026-04-29 (first user event at block 86180662, 2026-04-29 16:49 UTC), emit `PositionSplit`, `PositionsMerged`, `PositionsRedeemed` and, on the neg-risk one, `PositionsConverted`, each with the user as `initiator` (rows 4, 5, 12, 13, 16). The plan dates the switch to 2026-05-01; the chain shows the new adapters live from 2026-04-29.

Two auto-redeemers also act for users: `ctf_auto_redeem` and Protocol V2's `auto_redeemer`. Both emit `BinaryRedemption(from, conditionId, payout)` and `NegRiskRedemption(from, conditionId, payout)` naming the user (rows 7, 14, 15).

So the CTF source loads the four `collateral_adapter.*` events from the current adapters and the two `auto_redeemer.*` events from both redeemers. It does not need `TransferSingle` or `TransferBatch` for them.

The gap is users who still call the old binary adapter directly. In blocks 96924000–96925999 they made 67 calls (20 merges, 47 redemptions, no splits) against 36,028 exchange calls through the same adapter. In blocks 94738440–94740439 they made 59. No event the adapter or ConditionalTokens emits names them. Two ways to load them:

1. pUSD `Wrapped(caller, asset, to, amount)` with topic1 (`caller`) = an old adapter. `to` is the user and `amount` the pUSD paid out; the same transaction's ConditionalTokens `PositionsMerge` or `PayoutRedemption` with that adapter as stakeholder gives the condition. In blocks 96924000–96925999 that filter matched 1,601 logs: 67 to wallets, 1,242 to `ctf_exchange_v2`, 292 to `neg_risk_ctf_exchange_v2`. About 1.8 million over the window.
2. ConditionalTokens `TransferBatch` and `TransferSingle` with topic1 (`operator`) = an old adapter. That names the user and the shares, but the same filter matches the exchanges' mint and merge plumbing: about 78,000 per 2,000 blocks, 85 million over the window, for about 70 useful logs per 2,000 blocks.

Leaving them out loses about 0.2% of redemptions and merges (67 of about 35,000 per 2,000 blocks). The choice belongs to the CTF source's task.

### Q6. Outcome order

Index set `1 << i`, `payoutNumerators[i]` and outcome `i` line up, proven on chain for rows 2, 8 and 9 with ConditionalTokens' own `getCollectionId` and `getPositionId`:

| Row | Condition | Index set 1 position id | Index set 2 position id | `payoutNumerators` |
|---|---|---|---|---|
| 2 | `0xcf28ea01…fc6a` ETH Up or Down, Nov 7 6:35–6:40PM ET | `5649129532…990327` | `1036888840…191268` | [0, 1] |
| 8 | `0xb901c228…27cd` Beijing high temperature 3°C or below, Nov 8 (neg risk) | `4139144572…160788` | `2554925656…954439` | not resolved |
| 9 | `0x21a77299…ade3` BNB Up or Down, Oct 15 4–8AM ET | `3221025778…875301` | `4875577082…346082` | [1, 0] |

Dune's market table lists the index set 1 token as outcome index 0 ("Up", "Up", "Yes") and the index set 2 token as outcome index 1 in all three. For row 9 it lists the market closed with "Up" settled at 1 and "Down" at 0, the same as `payoutNumerators` [1, 0] in the `ConditionResolution` log. Polymarket's own `py-sdk` (`src/polymarket/models/gamma/market.py`) pairs `outcomes[i]` with `clobTokenIds[i]` and `outcomePrices[i]`. Not proven on a Gamma reply: that Gamma's `clobTokenIds[i]` is the index set `1 << i` token. Sources: Dune `polymarket_polygon.market_details` (queries 9089456, 9089458) and py-sdk at `ddee30cebb`.

### Q7. Conversions

`NegRiskAdapter.convertPositions(marketId, indexSet, amount)` takes `amount` NO shares of each question whose bit is set in `indexSet` (k questions) and returns:

- `(k − 1) × amountOut` collateral, and
- `amountOut` YES shares of each question whose bit is not set,

where `amountOut = amount − amount × feeBips / 10000`. Question `i` of a market has `questionId = marketId + i` (the low byte is the index) and condition id `getConditionId(neg_risk_adapter, questionId, 2)`. `PositionsConverted` names neither the YES questions nor `amountOut`. dbt finds the YES questions as the market's indexes (from `QuestionPrepared`) whose bit is not set, or from the NegRiskAdapter's `TransferBatch` to the stakeholder. The NO shares the user gave go to `no_token_burn_address`.

`feeBips` comes from `MarketPrepared(marketId, oracle, feeBips, data)`; `getFeeBips(marketId)` returns the same. All 13 `MarketPrepared` logs in blocks 96924000–96925999 had `feeBips` 0. Dune's market table lists `fee_bips` 0 for all 132,916 neg-risk markets it has and null for 260 (not proven on a Gamma reply; Dune query 9089467).

Row 8 checks it: market `0x7d0bd97d…f000` has 11 questions (`getQuestionCount`) and `feeBips` 0. `indexSet` 510 sets bits 1–8, so k = 8. The user got 7 × 5,000,000 = 35,000,000 USDC.e (log 187) and 5,000,000 YES of questions 0, 9 and 10 (log 188), whose ids equal `getPositionId(marketId + i, true)` for i = 0, 9, 10. Row 13 shows the adapter path: `collateral_adapter.PositionsConverted` adds `amountOut` (10,000,000) and the adapter wraps the 30,000,000 USDC.e (k = 4) into pUSD for the user.

## Redemptions

ConditionalTokens' `PayoutRedemption` names the payout and the index sets, not the shares. `redeemPositions` burns the caller's whole balance of each index set it names, winners and losers (row 6 burns 10,000 losing and 186,826,243 winning shares for 186,826,243). A call can name only some index sets; `0x76deb7f9cc73844892f7db75d42f3293e8696e1a80c9ee2c079f7ef40109e4cd` (block 96926001) names `[1]` only. The adapters and auto-redeemers pull the user's whole balance of both outcomes first (rows 12, 14, 15), so their redemptions zero both. `neg_risk.PayoutRedemption` and `collateral_adapter.PositionsRedeemed` carry `amounts[]`, the shares per outcome; the auto-redeemer events carry only `payout`.

Many redemptions pay 0: a loser cleaning up, or a call with nothing to redeem. In blocks 96924000–96925999, 9,995 of 25,769 ConditionalTokens redemptions paid 0.

## Traps

- `collateral_adapter.PositionSplit` and `neg_risk.PositionSplit` share topic0 `0xbbed930d…`. `BinaryRedemption` and `NegRiskRedemption` come from two contracts. Filter every event by its emitting address.
- One user action emits up to three split, merge or redemption events (ConditionalTokens, NegRiskAdapter, adapter). Only the one naming a non-Polymarket address is the user's. Summing all of them triples volume.
- The exchanges' mints and merges are the old adapters' ConditionalTokens events. Dropping exchange addresses alone does not remove them.
- Users migrate CTF positions into Protocol V2 with transfers to `binary_module` and `neg_risk_module`, which then redeem them. The user's side of a migration is a transfer, which no planned source loads; Task 11 owns it.
- The Portal MCP's `portal_debug_resolve_time_to_block` gave block 95285329 for the ISO input `2026-10-01T00:00:00Z` ("estimated", 9.5 days late). Unix seconds (1790812800) gave the right block. Pass Unix seconds.
- `portal_evm_query_logs` with `response_format: summary` counts one page (at most 25 logs), not the window.

## Proof table

All rows come from SQD Portal for `polygon-mainnet` through the stream API with the log filter's `transactionLogs` option, so every log of each transaction came back. Decoding used the ABI files in `abis/` plus ERC-20 `Transfer` and pUSD's verified `Wrapped`/`Unwrapped`. Each row was checked against the pUSD, USDC.e, wrapped collateral and ConditionalTokens `TransferSingle`/`TransferBatch` logs of the same transaction. Amounts are base units (6 decimals). Market names and outcomes come from Dune's market table (not proven on a Gamma reply).

`ex` = `ctf_exchange_v2`, `nrex` = `neg_risk_ctf_exchange_v2`, `ad1` = `ctf_collateral_adapter_v1`, `cad1` = `ctf_collateral_adapter`, `cad2` = `neg_risk_ctf_collateral_adapter`, `nra` = `neg_risk_adapter`.

| # | Event | Block | Transaction | Logs | Decoded fields | How it was confirmed |
|---|---|---|---|---|---|---|
| 1 | ctf_exchange_v2.OrderFilled, buy against sell | 96926000 | `0x58f6ac1b129ebbf968d51fd5f66ed0563ee317b5b862e7c8f93bd4ab5e00ba30` | 403 maker, 405 taker | XRP Up or Down Nov 7 6:30–6:35PM ET, token `21815194618493357610873019371928881814153899863038016502475197588875103719951` (Down). Log 403: maker `0x1dd2a69e73ba444ecd5d87f0073d51a670ad51c2`, taker `0x8d220bbd98c5e47d9ae7781811cbba029cbaae40`, side 1, makerAmountFilled 5106383, takerAmountFilled 4800000, fee 0. Log 405: maker `0x8d22…ae40`, taker = ex, side 0, makerAmountFilled 4800000, takerAmountFilled 5106383, fee 20160. Price 4800000 / 5106383 = 0.94. | TransferSingle 401 moves 5106383 of the token from seller to buyer. pUSD 402 moves 4800000 buyer → seller; pUSD 407 moves 20160 buyer → `fee_receiver`; FeeCharged 404 = 20160. |
| 2 | OrderFilled, mint match | 96926000 | `0x14fb5757ffc3eed1d302c1db6fe17d9787ef4c309740b87bf4ad7d7e8ada860c` | 98 maker, 102 taker, 95 split | ETH Up or Down Nov 7 6:35–6:40PM ET, condition `0xcf28ea01af1aedbbb96bb3f2ed8efd5b4c52faaf057c98e59b118b75cc0afc6a`. Log 98: maker `0x3bfcd24e25e446d31eb4825b96b1ed515e36a199` buys Down (`103688884060883873727013522652996002941410548793093120456496990699655719191268`) 4442100 pUSD for 8710000, fee 0. Log 102: maker `0xe439b8e52eeeeda4eff19a10a4307706a85d61b4`, taker = ex, buys Up (`56491295322642479574009649190264906678337478953962544953766149611910922990327`) 4267900 for 8710000, fee 152360. Log 95: ctf.PositionSplit stakeholder = ad1, collateral USDC.e, amount 8710000. Prices 0.51 and 0.49. | pUSD 85 (4420260 = 4267900 + 152360) and 86 (4442100) into ex; ad1 pulls 8710000 pUSD from ex and unwraps it (87, 90, Unwrapped 91); USDC.e 92 ad1 → ConditionalTokens 8710000; TransferBatch 94 mints both outcomes to ad1, 96 moves them to ex; TransferSingle 97 and 101 send 8710000 Down and Up to the two buyers. |
| 3 | OrderFilled, merge match | 96926007 | `0x160c578b42c8ed8e1ab41f09aca5f8fbd98fd3fbad4f8efccee958ee878dbdb3` | 659 maker, 662 taker, 653 merge | "Total Kills Over/Under 27.5 in Game 2?", condition `0x94c1669b1c2f3ed31e67e5cf37f4725905c58d524cb11b4686e379a452c33ed0`. Log 659: maker `0x200e9eb918a20e6baf5a60af14c65c9e4384e21d` sells Over (`58052577356328252628183651892588951427801085397945972476159165350688827473483`) 4470000 for 4246500, fee 0. Log 662: maker `0x7e7bc969274a14c241b66846fc699e9d0031afa2`, taker = ex, sells Under (`110891868994035549509428319985343688940098568959569462043345289006462020533224`) 4470000 for 223500, fee 10610. Log 653: ctf.PositionsMerge stakeholder = ad1, amount 4470000. Prices 0.95 and 0.05. | TransferSingle 648 and 649 move both sellers' shares to ex; TransferBatch 650 ex → ad1, 651 burns; pUSD 655 mints 4470000 to ex; pUSD 658 pays 4246500 and 660 pays 212890 (= 223500 − 10610); 664 sends 10610 to `fee_receiver`. |
| 4 | collateral_adapter.PositionSplit (user split) | 96926001 | `0xd97bece7d3eeb1908edd64f2028c8d986a5ec4ecf3f9b41d21beaa9b9be75215` | 208, 206 | Log 208: cad1 PositionSplit initiator `0xa537aec79808a7c6f0bcc70eacca189e3f3477fe`, condition `0x30dc1d24ca16b5301ed82c298e206fb988d04627efd798e7eca34fbff7df4b52` (Bitcoin Up or Down Nov 7 6:35–6:40PM ET), amount 150000000. Log 206: ctf.PositionSplit stakeholder = cad1, USDC.e, 150000000. | pUSD 198 moves 150000000 user → pUSD and 201 burns it; USDC.e 203 cad1 → ConditionalTokens; TransferBatch 207 sends 150000000 of both outcomes cad1 → user. |
| 5 | collateral_adapter.PositionsMerged (user merge) | 96926001 | `0x17c9a2c57c3fffe945c9405ca17304d851581290eec5ff7345e38ab3497dea0a` | 278, 273 | Log 278: cad1 PositionsMerged initiator `0x228b8d11eba89bf1c554f8879a9293b7106daf4c`, condition `0x54785fb9b8ca54bd747a6c03e9907c84c26a1caf6643715c697eec473f59d6cd`, amount 161790000. Log 273: ctf.PositionsMerge stakeholder = cad1. | TransferBatch 270 moves 161790000 of both outcomes user → cad1; USDC.e 272 ConditionalTokens → cad1; pUSD 275 mints 161790000 to the user. |
| 6 | ctf.PayoutRedemption (direct) | 96926007 | `0x71119fa6e5180d26b5415f8629cffd21f36c3f35460823f28b8b6e97150ff83e` | 1365 | redeemer `0x26d76c9bd18c5322ae112c9dbb6e96a2a1159b82`, USDC.e, condition `0xe447be6d6f2ad8d109b548594a251296137a5afa1fa6f468c909060890cb549c` (Bitcoin Up or Down Nov 7 6:25–6:30PM ET), indexSets [1, 2], payout 186826243. | TransferSingle 1362 burns 10000 Up (index set 1, `payoutNumerators[0]` = 0) and 1363 burns 186826243 Down (index set 2, `payoutNumerators[1]` = 1); USDC.e 1364 pays 186826243 to the redeemer. |
| 7 | neg_risk.PayoutRedemption | 96926008 | `0xf12f6adb5cd1f8edc4f3ef26efd6bc97f7e4cbd6df7072ec6d79e6510d43a084` | 1072, 1069, 1078 | Log 1072: nra PayoutRedemption redeemer = `auto_redeemer`, condition `0x031071a274d8c857452bfaf84175163b177d8021db125f46f92623819df3db95` ("New England Revolution leading at halftime?"), amounts [0, 24285715], payout 24285715. Log 1069: ctf.PayoutRedemption redeemer = nra, wrapped collateral. Log 1078: auto_redeemer NegRiskRedemption from `0xe70c0ad7184d7572008488cb073f6d5e607917c5`, payout 24285715. | TransferBatch 1065 moves [0, 24285715] user → auto_redeemer, 1066 on to nra; TransferSingle 1067 burns 24285715 NO (`payoutNumerators` [0, 1]); wrapped collateral 1068 and USDC.e 1071 pay 24285715; pUSD 1075 mints it to the user. |
| 8 | neg_risk.PositionsConverted (direct) | 96926001 | `0xf7da1a7814f7860e4f145bfd26a1713371994955723b44438b6496f38e665496` | 189 | stakeholder `0xadcefdd84ffd58d9500c4d03e328b016ef94a482`, market `0x7d0bd97d337485c07cd88ba4472550d70754736175642907c3bf2834b8bff000` (11 questions, feeBips 0), indexSet 510, amount 5000000. | TransferBatch 185 sends 8 NO × 5000000 user → `no_token_burn_address`; PositionSplit 178, 181, 184 split questions 0, 9, 10; USDC.e 187 pays 35000000 = 7 × 5000000; TransferBatch 188 sends 5000000 YES of questions 0, 9, 10 to the user. |
| 9 | ctf.ConditionResolution | 95573552 | `0xf7ad2df84dee12995955bbe2b30cfab664860b42b12c637def7c404b1cd45741` | 698 | condition `0x21a77299dec1537c744abdbcb382c9e6b9d2386b8a495948f5745a336e8bade3`, oracle `0x58e1745bedda7312c4cddb72618923da1b90efde`, question `0x3eb8976c590698d977b3708eaeeba997a5220b8f5e0454422ffaaef26dcac854`, 2 outcomes, payoutNumerators [1, 0]. Block time 2026-10-15 12:00:53 UTC. | `getConditionId(oracle, question, 2)` returns the condition. Dune lists "BNB Up or Down - October 15, 4:00AM-8:00AM ET" closed, resolved at 12:00:53 UTC, "Up" (outcome 0, token `32210257784509415691320375334453862893439494594095949869273938405916136875301`) settled at 1 and "Down" at 0 (not proven on a Gamma reply). `getPositionId` puts that token at index set 1; `payoutNumerators(condition, 0)` returns 1. |
| 10 | OrderFilled with fees on both sides | 96926003 | `0x8ddf719cb8f7451293eecd6f0a89786582c0544809c8d545b763abe3eddcc167` | 333 maker, 335 taker | "LoL: Invictus Gaming vs Gen.G - Game 2 Winner", token `95925888873018679830803815086905784068229941729943579604241272453075308214452` (Invictus Gaming). Log 333: maker `0x066dea1e1c12871afdffecd2c11cdf9636101bff` sells 500000000 for 5500000, fee 2750. Log 335: maker `0x7e3a4d652e9ebd60ff54df022950ac736337130e`, taker = ex, buys 500000000 for 5500000, fee 271970. Price 0.011. | TransferSingle 330 moves 500000000 seller → buyer; pUSD 332 pays the seller 5497250 = 5500000 − 2750; pUSD 337 sends 274720 = 271970 + 2750 buyer → `fee_receiver`; FeeCharged 331 = 2750 and 334 = 271970. |
| 11 | OrderFilled, sell against buy | 96926000 | `0x6c3074e6aae586c1f25446da78e9a3e16db5288afe34b5982724b548cb431a38` | 78 maker, 81 taker | token `105985080724064245114012949518165989083729807961896494806795246958083187261670`. Log 78: maker `0x3089fcf3fe5b67ec287654b4d627bcd1d51135e4` buys 5000000 for 3650000, fee 0. Log 81: maker `0x20d2309cd92b797ae7ca175ed828ed8a27fbe29d`, taker = ex, sells 5000000 for 3650000, fee 68980. Price 0.73. | TransferSingle 76 moves 5000000 seller → buyer; pUSD 77 moves 3650000 buyer → ex, 80 pays the seller 3581020 = 3650000 − 68980, 83 sends 68980 to `fee_receiver`. |
| 12 | collateral_adapter.PositionsRedeemed | 96926001 | `0xab58c40fc83ec91a34d4bff6d5f0c4231f533e4e3c939dfaa8ba7c8e6e95954b` | 307, 302 | Log 307: cad1 PositionsRedeemed initiator `0x36741d4cb1046ab38ee013cf6582dcec16ca11c3`, condition `0x46f8c1c155ae61f89c88e2c6e2a585f9bb59f856b69a9b1b439105bad8232e42` (Bitcoin Up or Down Nov 7 6:15–6:30PM ET), amounts [50000000, 0], payout 50000000. Log 302: ctf.PayoutRedemption redeemer = cad1. | TransferBatch 299 moves [50000000, 0] user → cad1; TransferSingle 300 burns 50000000 Up; USDC.e 301 pays cad1; pUSD 304 and Wrapped 306 give the user 50000000. |
| 13 | collateral_adapter.PositionsConverted | 96926004 | `0x027e95fdb039910da4ca6dfbb7bdd6e8d2b29312c677e3151ef8fa596c1b08c7` | 663, 661 | Log 663: cad2 PositionsConverted initiator `0xb0c85813a7a4428f1139ff91d3118a92c391fe7f`, market `0x0e8939bc6c4ed6d9b16a96d5a76c33708bb084b47fcfa848cd8cf98510e82a00` (11 questions, feeBips 0), indexSet 480, amount 10000000, amountOut 10000000. Log 661: nra PositionsConverted stakeholder = cad2. | indexSet 480 sets bits 5–8, so k = 4: USDC.e 659 pays cad2 30000000 = 3 × 10000000 and Wrapped 667 gives the user 30000000 pUSD; TransferBatch 662 sends 7 YES × 10000000 cad2 → user. |
| 14 | auto_redeemer.BinaryRedemption (`auto_redeemer`) | 96926002 | `0x096e10a856368be2fb5f40b5c0ab15cc4824f02dedbaf2e6dd63b8489cf4a04e` | 237, 231 | Log 237: from `0x0591944287e0c1a2e36408d6fee8ca1f30eab637`, condition `0x23a37bfeb244d20c0f62feb5c678c2014d45956529b137dbbbacaab30aff73bf` ("FC Cincinnati vs. Nashville SC: O/U 3.5"), payout 100000000. Log 231: ctf.PayoutRedemption redeemer = `auto_redeemer`. | TransferBatch 228 moves [0, 100000000] user → `auto_redeemer`; 229 burns 100000000 Under; USDC.e 230 pays 100000000; pUSD 234 mints it to the user through the onramp (Wrapped 236). |
| 15 | auto_redeemer.BinaryRedemption (`ctf_auto_redeem`) | 96926002 | `0xe972e1c7b30771d642b9c6ee2cf05b92ea60788ed703fd5d95eb063c0ef5ebdf` | 193, 187 | Log 193: from `0x051adea0d16c85df8a8a9c7e400e0655905d1db9`, condition `0x4348d80e651c55299490175a8302bbb7e1af32ea66269616feaa1463d0ca793e`, payout 9600000. Log 187: ctf.PayoutRedemption redeemer = `ctf_auto_redeem`. The same transaction redeems for three more users. | TransferBatch 184 moves [0, 9600000] user → `ctf_auto_redeem`; 185 burns 9600000; USDC.e 186 pays it; pUSD 190 mints 9600000 to the user. |
| 16 | collateral_adapter.PositionSplit (neg risk) and neg_risk.PositionSplit | 96926000 | `0x6e556433f0864b6a8a3e54c3c2f7f5e473324f9726155a5dc5c7f1fd76f25f4d` | 613, 611, 609 | Log 613: cad2 PositionSplit initiator `0xb6b75c6237963985abc74daf9c8579533772c370`, condition `0xde162ab4876dfc578c15630549a088b9e5e2acd717c2875e7164742cdff7d760`, 60000000. Log 611: nra PositionSplit stakeholder = cad2. Log 609: ctf.PositionSplit stakeholder = nra, wrapped collateral. | pUSD 597 moves 60000000 user → pUSD (Unwrapped 601); USDC.e 602 cad2 → nra, 604 → wrapped collateral; TransferBatch 612 sends 60000000 of both outcomes cad2 → user. |
| 17 | OrderFilled on `neg_risk_ctf_exchange_v2` | 96926000 | `0xfa460c3dc97c63087e3a0227f35cd40b6ebcfca4201136f76d84f9a03d7b0d7e` | 70 maker, 72 taker | token `33339798372916037220786136133406478491116150628220441951753426683441228279665`. Log 70: maker `0x3e9ff2dbf2a6356ee47049e9f3c43a70cb55d57f` sells 5000000 for 10000, fee 0, taker `0xc69bd5567b40ef4d11922eaa57e1f9be1c642076`. Log 72: maker `0xc69b…2076`, taker = nrex, buys 5000000 for 10000, fee 290. Price 0.002. | TransferSingle 68 moves 5000000 seller → buyer; pUSD 69 moves 10000 buyer → seller; pUSD 74 sends 290 to `fee_receiver`. |

## Load estimate

Counted over three 2,000-block samples through the Portal stream API, one request per sample: blocks 94738440–94740439 (2026-10-01 00:00–00:50 UTC), 95830000–95831999 (2026-10-19 22:52–23:42) and 96924000–96925999 (2026-11-07 22:44–23:34). The Portal MCP cannot count these: its `summary` covers one page of at most 25 logs, and one sample holds over 100,000 fills. To check the method, the MCP and the stream API counted the same 5 blocks (96925995–96925999): 10 ConditionalTokens `PayoutRedemption` and 33 NegRiskAdapter logs (11, 14, 3, 2, 3 by topic) both ways. The window runs from block 94738440 to the head, 96927727 on 2026-11-08, 2,189,288 blocks, 1,094.6 samples.

| Logs | Per 2,000 blocks (Oct 1, Oct 19, Nov 7) | Window, at the mean (low–high) |
|---|---|---|
| v2 `OrderFilled` (the exchange v2 source) | 100,924 / 104,957 / 157,506 | 133 million (110–172) |
| ConditionalTokens preparation, resolution, split, merge, redemption | 57,456 / 58,924 / 91,710 | 76 million (63–100) |
| NegRiskAdapter, all events | 8,067 / 7,279 / 13,196 | 10 million (8–14) |
| Current adapters' four events | 9,223 / 11,436 / 15,571 | 13 million (10–17) |
| Auto-redeemers' two events | 9,506 / 8,859 / 13,547 | 12 million (10–15) |
| CTF source total (the four rows above) | 84,252 / 86,498 / 134,024 | 111 million (92–147) |
| Q5 option 1: pUSD `Wrapped` by an old adapter | — / — / 1,601 | about 1.8 million |
| Q5 option 2: CTF transfers with an adapter or redeemer as operator | 91,935 / 93,550 / 133,018 | 116 million |
| All CTF `TransferSingle` and `TransferBatch` | 207,226 / 209,165 / 308,126 | 264 million |
| v1 `OrderFilled` | 0 / 0 / 0 | 0 |
| v1 `TokenRegistered` | 224 / 238 / 222 | 0.25 million |

Within each sample `ctf_exchange_v2` emitted about 80% of the fills and `neg_risk_ctf_exchange_v2` the rest; `neg_risk_ctf_exchange_v2_retired` emitted nothing. The window holds no v1 fill in the samples, as Decision 2 expects. The Nov 7 sample (a Saturday evening) is about 50% busier than the other two, so the totals are rough.

## Time window used for checks

Portal (`portal_debug_resolve_time_to_block` with Unix seconds 1790812800) resolves 2026-10-01 00:00:00 UTC to block 94738440, whose timestamp is exactly 2026-10-01 00:00:00 UTC (verified boundary). A binary search on `eth_getBlockByNumber` gives the same: block 94738439 is 1790812799, block 94738440 is 1790812800. The window's first block is 94738440, included.

## Rerunning the checks

From the worktree root, every topic0 in `protocol.yaml` against its signature and its ABI file:

```
uv run --project orchestration python -c 'import json,yaml; p=yaml.safe_load(open("catalog/protocols/polymarket/protocol.yaml")); print(json.dumps([{"key":k,**{f:v.get(f) for f in ("signature","topic0","abi")}} for k,v in p["events"].items()]))' \
  | (cd ingestion/lib && node -e 'const {toEventSelector,parseAbiItem}=require("viem"); let bad=0; for (const e of JSON.parse(require("fs").readFileSync(0,"utf8"))) { const s=toEventSelector(parseAbiItem(e.signature)); const n=e.key.split(".")[1]; const a=e.abi ? toEventSelector(require("../../catalog/protocols/polymarket/"+e.abi).find(x=>x.name===n)) : s; const ok=s===e.topic0 && a===e.topic0; bad+=!ok; console.log(ok?"ok ":"BAD", e.key, e.topic0); } process.exit(bad)')
```

Position ids, payouts and condition ids come from `eth_call` to ConditionalTokens: `getCollectionId(bytes32,bytes32,uint256)`, `getPositionId(address,bytes32)`, `payoutNumerators(bytes32,uint256)` and `getConditionId(address,bytes32,uint256)`. Neg-risk market facts come from the NegRiskAdapter's `getFeeBips(bytes32)`, `getQuestionCount(bytes32)` and `getPositionId(bytes32,bool)`.
