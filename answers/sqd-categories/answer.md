# SQD transfers on Arbitrum and Base in October 2026, by category

52.37% of the SQD that moved between addresses on Arbitrum and Base in October 2026 went to or came from an exchange or one of its deposit addresses.

| Category | Chain | Transfers | SQD | Senders | Recipients |
|---|---|---|---|---|---|
| exchange | arbitrum | 2607 | 802506873.057650 | 289 | 288 |
| contract | arbitrum | 10566 | 512118193.135307 | 344 | 402 |
| contract | base | 5386 | 73811855.737479 | 222 | 297 |
| p2p | arbitrum | 1009 | 141415063.527725 | 210 | 226 |
| p2p | base | 15 | 1051139.295850 | 9 | 10 |
| bridge | arbitrum | 9 | 1210992.334705 | 2 | 2 |
| bridge | base | 3 | 330782.285588 | 1 | 1 |

Each category has its own file in `results/`:

- `sqd_categories_exchanges.csv`: each exchange and every wallet that sent it SQD or got SQD from it, with the SQD each way and whether the wallet used a deposit address.
- `sqd_categories_contracts.csv`: each contract and every address on the other side of its SQD transfers.
- `sqd_categories_bridges.csv`: every SQD move between Arbitrum or Base and Ethereum, with the move on the other L2 it pairs with.
- `sqd_categories_p2p.csv`: every pair of EOAs that sent SQD from one to the other, on one chain or across the two.

## Exchanges

Dune labels 15 addresses of 11 exchanges among the October SQD addresses, all on Arbitrum; none on Base. Coinbase dealt with 59 wallets: 176902162 SQD in and 131220100 out, 28 of the wallets through deposit addresses. MEXC dealt with the most wallets, 85. 36 addresses that each got SQD only from `0x15da7556d5ed888306839bed06f868aeaedcb0d7` and passed all of it to Coinbase's `0xe68ee8a12c611fd043fb05d65e1548dc1383f2b9` count as Coinbase deposit addresses, so `0x15da…` shows as a wallet that paid Coinbase through them.

## Contracts

313 contracts sent or got SQD in transfers whose category is contract. The busiest, `0xc24b560c7f8a1a50c2336cd8917af61b5e14984f` on Arbitrum, dealt with 99 addresses. The contracts are not named; DEX pools, routers and staking or vesting contracts are likely among them.

## Bridges

All 12 SQD bridge moves in October are by one EOA, `0x81004f46e7fda526bd49529b544011dad06cfab9`, to and from the same address on Ethereum. Two of its Arbitrum withdrawals pair with Base deposits: 74779.634314 SQD left Arbitrum on 2026-10-02 and reached Base on 2026-10-09, and 195811.479338 SQD left on 2026-10-08 and arrived on 2026-10-15. The other moves went between Arbitrum or Base and Ethereum only. No SQD left Base.

## P2P

355 pairs of EOAs: 343 on Arbitrum, 11 on Base, and 1 across the chains, the `0x8100…` pair above, from that address on Arbitrum to itself on Base, 270591.113652 SQD in 2 transfers.

## How it was counted

- SQD is `0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1` on Arbitrum and Ethereum, and `0xd4554bea546efa83c1e6b389ecac40ea999b3e78` on Base.
- An exchange is an address in Dune's `cex.addresses` labels for its chain (`transformation/seeds/cex_addresses.csv`), or an address that sent every transfer it made in October to one such exchange's addresses (a deposit address).
- A contract is an address with code, read with `eth_getCode` at the latest block on 2026-11-05. An EOA has no code, or has an EIP-7702 delegation.
- A transfer's category is the first that fits: bridge (a mint or burn), exchange (either side), contract (either side), P2P (both sides EOAs). Transfers from an address to itself are left out.
- A bridge withdrawal pairs with a deposit into the other L2 through the same Ethereum address, for the same amount, at least 6.4 days later from Arbitrum or 1 day from Base; within one address and amount, the nth withdrawal pairs with the nth deposit.

## Data

- October 2026 UTC: Arbitrum blocks 510496864 to 520129273, Base blocks 52011727 to 53350926.
- SQD transfers from `evm-erc20-transfers`; bridge events from `arbitrum-token-bridge` and `base-op-standard-bridge` (catalog entries in `catalog/protocols/`); code from `evm-address-code`; exchange labels from Dune, exported on 2026-11-05.
- Last loads: Arbitrum transfers 2026-11-05T17:04:17.417000Z, Base transfers 2026-11-05T17:06:09.230000Z, Arbitrum bridge 2026-11-05T19:19:30.938000Z, Base bridge 2026-11-05T19:21:10.694000Z, Arbitrum code 2026-11-05T18:22:32.031000Z, Base code 2026-11-05T18:21:11.080000Z.
- Checks: dbt tests (93 passed), dead letters, freshness and coverage passed. The cross-check passed: Portal and the warehouse both hold one Base SQD `ERC20BridgeFinalized` in blocks 52370000 to 52390000, at block 52377952, of 74779634313900000000000 base units.

## Caveats

- Dune's labels cover only some exchange addresses, and none on Base. An unlabelled exchange wallet counts as an EOA or a contract, which moves its transfers into P2P or contract.
- The deposit rule also catches a person's own wallet that sent all its October SQD to one exchange.
- Code was read on 2026-11-05, not at the end of October: an address that became a contract after October counts as one.
- The bridge pairing infers; it does not prove. Loading Ethereum's side of each bridge would prove each hop.
- Other readings change the numbers: code read at the window's end, inferred deposit addresses left out, EIP-7702 delegated EOAs counted as contracts, or bridges paired through Ethereum's own events.
