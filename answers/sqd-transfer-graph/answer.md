# The SQD transfer graph on Arbitrum and Base, October 2026

1274 wallets sent SQD to one another along 2444 edges in October 2026, on Arbitrum and Base together.
An edge runs from a sender to a recipient and carries the transfers and SQD that went that way.

- `results/sqd_transfer_graph_by_edge.csv` lists every edge, most SQD first, with SQD and transfers per chain.
- `results/sqd_transfer_graph_by_wallet.csv` lists every wallet: how many wallets it sent SQD to and got SQD from, and the SQD on those edges.

Both files load into a graph tool such as Gephi: map `from_address` to source and `to_address` to target.

## How it was counted

- SQD is `0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1` on Arbitrum and `0xd4554bea546efa83c1e6b389ecac40ea999b3e78` on Base, as in `answers/sqd-net-accumulators`.
- An edge from A to B means A sent B at least one SQD Transfer in the window. Edges are directed. An edge adds up both chains and keeps each chain's share.
- A wallet is any address, contracts included. Mints, burns and transfers from an address to itself make no edge.

## Data

- October 2026 UTC: Arbitrum blocks 510496864 to 520129273, Base blocks 52011727 to 53350926, the same window as `answers/sqd-net-accumulators`.
- The `erc20_transfers` mart, from `raw.arbitrum_erc20_transfers` and `raw.base_erc20_transfers`. Last loads: Arbitrum finished 2026-11-05T17:04:17.417000Z, Base 2026-11-05T17:06:09.230000Z.
- Checks: dbt tests (37 passed), dead letters, freshness and coverage passed. The cross-check passed: for the edge from `0xe68ee8a12c611fd043fb05d65e1548dc1383f2b9` to `0xdd43644c3abbd26ed9a76075b020cf2cff5570ef` on Arbitrum, the keyed Portal stream and the warehouse both hold 7 transfers of 44904358355658269692059992 base units.

## What the graph shows

- The SQD sits on a few edges. The top 100 edges by SQD hold 64.5% of the 1530903124.754014 SQD that moved between wallets; the top 300 hold 90.0%.
- 36 addresses each got SQD only from `0x15da7556d5ed888306839bed06f868aeaedcb0d7` and sent it only to `0xe68ee8a12c611fd043fb05d65e1548dc1383f2b9`, 87590740 SQD in all. `0xe68e…` also sent 73087950 SQD straight back to `0x15da…` in 45 transfers. SQD runs in a loop between these two wallets.
- 211 pairs of wallets sent SQD both ways. 23 edges carry transfers on both chains.

## Caveats

- Contracts count as wallets, so exchange, bridge, pool and staking contracts sit in the graph as nodes; the answer does not check which addresses hold code.
- 141 edges carry only zero-value transfers.
- Other readings change the graph: undirected edges, only pairs that sent SQD both ways, mints and burns as edges, leaving out zero-value transfers, or one graph per chain.
