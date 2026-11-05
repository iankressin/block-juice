# The SQD flow map of October 2026 on Arbitrum and Base

11 addresses that are no exchange took SQD out of one exchange and paid SQD into a different one in October 2026.

The graph has 1091 entities and 2123 edges. An exchange is one entity: its labelled addresses and its deposit addresses together. A mint or burn connects a wallet to its chain's bridge to Ethereum. Moves inside one exchange are left out.

## What the map shows

- **Wallets paid more SQD into exchanges than they took out.** EOAs sent 224395693.513081 SQD to exchanges and got 173450977.125982 back: 50944716.387099 SQD more went in than came out.
- **Exchanges and contracts barely touch.** Exchanges sent 560379.783575 SQD to contracts and got 5348238.720181 from them. SQD reaches contracts through EOAs (130048116.078723) and other contracts (294691795.341091), the largest flow of all.
- **69687487.298390 SQD went straight from one exchange to another.** The largest: Coinbase to Revolut, 31160601 SQD in 22 transfers; Gate.io to Coinbase, 6231697.81 in 22; Coinbase to Gate.io, 4878369.604473 in 13.
- **One wallet moves SQD between Coinbase and Revolut.** `0x15da7556d5ed888306839bed06f868aeaedcb0d7` took 125837004 SQD from Coinbase and Revolut and paid 119790299 into the two. It is the hub of the relay pattern in `answers/sqd-transfer-graph`: its payments into Coinbase go through 36 deposit addresses.
- **The other 10 cross-exchange wallets are smaller**, from 29138.47 to 5189999.2 SQD taken out. They move between MEXC, Bybit, KuCoin, Gate.io, Bitvavo, Indodax and Coinbase, for example `0xd7266b7ae59ab827d9529f37c14978c080871499`, from MEXC to Bybit.
- **One wallet bridged SQD from Arbitrum to Base**, `0x81004f46e7fda526bd49529b544011dad06cfab9`, to itself, 270591.113652 SQD in 2 paired moves. It is the only Arbitrum-to-Base flow.

## Files

- `results/sqd_flow_map_groups.csv`: SQD from each group of entity (exchange, contract, eoa, bridge) to each other.
- `results/sqd_flow_map_edges.csv`: every edge of the entity graph, with each end's group, the chain and the category.
- `results/sqd_flow_map_cross_exchange.csv`: the 11 cross-exchange wallets, the exchanges each took from and paid into, and how much.

## How it was counted

The definitions of SQD, the window, exchanges, contracts, EOAs, bridges and P2P are those of `answers/sqd-categories`. Entities and groups are in `question.yaml`. The classification is `transformation/macros/classified_transfers.sql`.

## Data

- October 2026 UTC: Arbitrum blocks 510496864 to 520129273, Base blocks 52011727 to 53350926.
- The same loads as `answers/sqd-categories`: Arbitrum transfers 2026-11-05T17:04:17.417000Z, Base transfers 2026-11-05T17:06:09.230000Z, Arbitrum bridge 2026-11-05T19:19:30.938000Z, Base bridge 2026-11-05T19:21:10.694000Z, code readings 2026-11-05T18:21:11.080000Z and 18:22:32.031000Z.
- Checks: dbt tests (93 passed), dead letters, freshness and coverage passed. The data's cross-checks are in `answers/sqd-net-accumulators`, `answers/sqd-transfer-graph` and `answers/sqd-categories`: Portal and the warehouse agree on SQD transfers, one transfer pair's amount, and a Base bridge deposit.

## Caveats

- Collapsing an exchange hides moves between its own addresses, and Dune's labels miss some exchange wallets, which then show as EOAs or contracts.
- A flow between two exchanges may be one customer's withdrawal to another exchange, or the exchanges' own business: the data cannot tell them apart.
- The deposit rule, the code reading date and the bridge pairing carry the caveats of `answers/sqd-categories`.
