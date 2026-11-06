The three tracked wallets hold **3055.159790 ETH** between them.

## How it was counted

- **Tracked wallets** are the three wallets in `ingestion/sources/evm-eth-balances/chains/ethereum/addresses.json`.
- **Right now** is each wallet's latest ETH balance reading, at Ethereum block 26342618.
- Each balance is `eth_getBalance` at that block, summed in wei and divided by 10^18.

| Wallet | ETH |
|---|---|
| 0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43 | 3048.576029 |
| 0xd8da6bf26964af9d7eed9e03e53415d37aa96045 | 5.780441 |
| 0x28c6c06298d514db089934071355e5743bf21d60 | 0.803319 |

## The data

The balances come from `analytics.latest_balances`. The Ethereum balances source last loaded at 2026-11-04T19:18:40Z. All 54 dbt tests upstream of the analyses passed, and no input has dead letters.

## Caveats

- Native ETH only. ERC-20 tokens such as WETH are not counted.
- The figure is rounded to 6 decimals. `results/tracked_wallets_eth_by_wallet.csv` has each balance in wei.
