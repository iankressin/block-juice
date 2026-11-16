# HyperCore fills: notes

These notes cover HyperCore fills as SQD Portal's `hyperliquid-fills` dataset serves them. Every fact below comes from the 24 fills of block 1223800001 (2026-11-16 20:38:52.843 UTC), read through the Portal MCP, unless it says it comes from the notation page in `protocol.yaml`. The proof table at the end lists the fills each fact rests on.

## What one fill is

A fill is one user's side of one trade. The two sides of a trade are two fills that share `tid`, with the same `coin`, `px` and `sz`. Every `tid` in the block appears on exactly two fills, and the pair sits at adjacent fill indexes: fills 0 and 1 share tid 374728780679102.

`hash` names the action that made the trade, not the trade. Fills 2 to 7 share one hash across three tids. In them, one order (oid 607436620895, user `0x3037…1e83`) fills against three resting orders, one per tid. A resting order can fill under several hashes: oid 607436619018 fills in fill 1 under hash `0x7efa…ae21` and in fill 3 under hash `0xe4a1…3318`.

`fillIndex` runs from 0 to 23 across the block's 24 fills, in order. The source keys each record by `<block>:<fillIndex>`.

## Fields

- `side` is the user's own side: B on fill 0 and A on fill 1, the two sides of one trade. Fill 1's `dir` is Close Long, so A is a sell. The docs define "B = Bid = Buy, A = Ask = Short" and add "Side is aggressing side for trades". In fills each user carries their own side, so `side` here is not the aggressor's side.
- `crossed` is true on one fill of each trade and false on the other. In fills 2 to 7, the order that fills against three resting orders is crossed on all three of its fills. The crossed fill is the taker.
- `fee` is what the user paid in `feeToken`, USDC on all 24 fills. A negative fee is a rebate to the user: fill 1, the resting side, has fee -0.00004. A resting order does not always earn a rebate: fill 5 is not crossed and pays 0.001805. Every crossed fill in the block pays a positive fee.
- `builder` and `builderFee` are set on fills 18, 20 and 22, all crossed, with builder `0x524c…571e`, and null on the other 21. Fill 18 has fee 0.203615 and builderFee 0.107166. This data does not show whether `fee` includes `builderFee`.
- `startPosition` is the user's signed position in the coin before the fill, in units of the coin. User `0x3037…1e83` buys 0.01 in fill 2 from 4305.693, and fill 4 starts at 4305.703. Fill 7 opens a short from -1.057, so a negative position is short.
- `closedPnl` is zero on the opening fill 0 and 0.004392 on the closing fill 1. Fill 19 closes a long at a loss, -1.205952.
- `dir` takes the values Open Long, Close Long, Open Short and Close Short in this block.
- `sz` is "In units of coin, i.e. base currency" (docs). `px` is the price; the docs give no unit.
- `time` equals the block header's `timestamp` on all 24 fills, 1794861532843. Both are Unix milliseconds.
- `builderFee`, `builder`, `twapId` and `cloid` come as null when unset. `twapId` is null on all 24 fills, and `cloid` is null on fills 12, 18, 20 and 22. Pipes drops a null field, so the raw row has no such key, and staging reads it as null.
- Portal's stream sends `px`, `sz`, `fee`, `closedPnl` and `startPosition` as JSON numbers. The Portal MCP prints them as strings.

## Coin names

Two forms appear in the block: a bare name (`ZEC`, fills 18 to 23) and a name with a prefix and a colon (`io:ANTH`, `xyz:ANT`, `xyz:SNDK`). Portal matches names exactly: a query for `zec` and `IO:ANTH` over blocks 1223800000 to 1223800002 returns no fills, while `ZEC` and `io:ANTH` have 18 there. List coins in `addresses.json` exactly as Portal spells them.

## Blocks

Block hashes are all zeros: block 1223800001 has `hash` and `parentHash` `0x0000…0000`. Never key or join on a block hash. A block with no fills that match the query arrives as a bare header.

## Proof table

All rows are block 1223800001.

| Fill | User | Coin | Side | Crossed | Fee | Other fields | What it shows |
|---|---|---|---|---|---|---|---|
| 0 | `0x4394…3498` | io:ANTH | B | true | 0.001171 | tid 374728780679102, hash `0x7efa…ae21`, Open Long, startPosition 16.597, closedPnl 0 | Taker side of a trade |
| 1 | `0x5b52…97a8` | io:ANTH | A | false | -0.00004 | same tid and hash, px 1694.7, sz 0.008, oid 607436619018, Close Long, closedPnl 0.004392 | Resting side, with a rebate |
| 2 | `0x3037…1e83` | io:ANTH | B | true | 0.000759 | oid 607436620895, hash `0xe4a1…3318`, sz 0.01, startPosition 4305.693 | One order, three trades in one hash (with 4 and 6) |
| 3 | `0x5b52…97a8` | io:ANTH | A | false | -0.00005 | oid 607436619018, hash `0xe4a1…3318` | One resting order under a second hash |
| 4 | `0x3037…1e83` | io:ANTH | B | true | 0.011237 | startPosition 4305.703 | startPosition moves by fill 2's size |
| 5 | `0x7e48…9a7b` | io:ANTH | A | false | 0.001805 | Close Long | Resting side that pays a fee |
| 7 | `0x0cf7…3e5b` | io:ANTH | A | false | -0.001027 | Open Short, startPosition -1.057 | Negative position is short |
| 18 | `0xc634…8f95` | ZEC | B | true | 0.203615 | builder `0x524c…571e`, builderFee 0.107166, cloid null | Builder fill |
| 19 | `0x4d96…0b4c` | ZEC | A | false | -0.002143 | Close Long, closedPnl -1.205952 | Closing at a loss |
