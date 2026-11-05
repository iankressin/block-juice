# Which wallets accumulated the most SQD across Arbitrum and Base in October 2026?

`0xdd43644c3abbd26ed9a76075b020cf2cff5570ef` gained the most: 36606181.181444 SQD net, all on Arbitrum.
The ten largest net gains:

| Address | Net SQD | On Arbitrum | On Base | Received | Sent |
|---|---|---|---|---|---|
| 0xdd43644c3abbd26ed9a76075b020cf2cff5570ef | 36606181.181444 | 36606181.181444 | | 44904358.355658 | 8298177.174214 |
| 0xfa501fe6fc2b91c7112db3e707b6f205365a99ca | 27222159.649668 | 27222159.649668 | | 27222159.649668 | 0.000000 |
| 0x395c11da2b75bddb17ece068863971f3b1ff5fe8 | 13651452.189671 | 13651452.189671 | | 13651452.189671 | 0.000000 |
| 0x0d0707963952f2fba59dd06f2b425ace40b492fe | 10050832.697374 | 10050832.697374 | | 20610782.766857 | 10559950.069483 |
| 0x37dcb4e443a06a3fe0e7098519c1d81181e5322b | 7018098.597588 | 7018098.597588 | | 10277498.609477 | 3259400.011889 |
| 0xe68ee8a12c611fd043fb05d65e1548dc1383f2b9 | 6221221.674614 | 6221221.674614 | | 144759668.139348 | 138538446.464734 |
| 0x15da7556d5ed888306839bed06f868aeaedcb0d7 | 6031119.000000 | 6031119.000000 | | 125837004.000000 | 119805885.000000 |
| 0x4025eb652dd1fb1213118bb41785bb8484903823 | 4950914.129950 | | 4950914.129950 | 29937515.362750 | 24986601.232800 |
| 0xb31a0d39d2c69ed4b28d96e12cbf52c5f9ac9a51 | 4835188.230339 | 4835188.230339 | | 39166086.062803 | 34330897.832464 |
| 0x9b64203878f24eb0cdf55c8c6fa7d08ba0cf77e5 | 4307678.053772 | 4307678.053772 | | 25220071.959303 | 20912393.905531 |

All 1274 addresses that moved SQD are in `results/sqd_net_accumulators_by_wallet.csv`, largest net gain first.

## How it was counted

- SQD is `0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1` on Arbitrum and `0xd4554bea546efa83c1e6b389ecac40ea999b3e78` on Base, 18 decimals each, from Portal's token list.
- Net new is the SQD an address received minus the SQD it sent, from the token's Transfer logs, added up over both chains by address.
- A wallet is any address that sent or received SQD, contracts included. The zero address is left out, since mints come from it and burns go to it.

## Data

- October 2026 UTC: Arbitrum blocks 510496864 to 520129273, Base blocks 52011727 to 53350926.
- Every SQD Transfer log of both tokens, loaded by `evm-erc20-transfers` into `raw.arbitrum_erc20_transfers` and `raw.base_erc20_transfers`, through the `erc20_transfers` mart.
- Last loads: Arbitrum finished 2026-11-05T17:04:17.417000Z, Base 2026-11-05T17:06:09.230000Z.
- Checks: dbt tests (37 passed), dead letters, freshness and coverage passed. The cross-check passed: Portal and the warehouse both count 14 SQD Transfer logs in Arbitrum blocks 515000000 to 515020000, and 8 in Base blocks 52705001 to 52707000.

## Caveats

- Contracts count as wallets. The top of the list is likely to hold exchange, bridge, staking or vesting contracts; the answer does not check which addresses hold code. The second and third addresses each got all their SQD in one transfer and sent none.
- SQD that one address bridges between the chains cancels out for that address, but the bridge contract on the sending side shows the SQD as its own gain.
- Other readings change the ranking: wallets without code only, the last 30 days (2026-10-05 to 2026-11-04) instead of the calendar month, each chain ranked on its own, or SQD received without what was sent.
