The three tracked Solana wallets hold **9318316.473172448 SOL** between them.

## How it was counted

- **Tracked wallets** are the three wallets in `ingestion/sources/solana-sol-balances/addresses.json`.
- **SOL** is native SOL only. SPL tokens, including wrapped SOL, are not counted.
- **Right now** is each wallet's latest SOL balance reading, at Solana slot 465371069.
- Each balance is read from the chain, summed in lamports and divided by 10^9.

| Wallet | SOL |
|---|---|
| 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM | 9300003.228029947 |
| H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS | 16965.396150800 |
| 86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY | 1347.848991701 |

## The data

The balances come from `analytics.latest_balances`. The Solana SOL balances source last loaded at 2026-11-04T19:18:41Z. All 54 dbt tests upstream of the analyses passed, and no input has dead letters.

## Caveats

- Staked SOL is not counted. Only the wallets' liquid balance is.
- `results/tracked_wallets_sol_by_wallet.csv` has each balance in lamports.
