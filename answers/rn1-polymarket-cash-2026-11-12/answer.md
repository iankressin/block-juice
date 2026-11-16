# What cash did RN1 hold on Polymarket, and what was it paid or did it take out apart from its trades?

**Answer.** Over Polygon blocks 91743315 to 97042228 (2026-08-10 to 2026-11-09 UTC), RN1 was paid **935,443.1125 pUSD** in transactions with no trade of its own. Its pUSD balance went from 1,115,926.995746 to 2,112,997.933970. It sent 1,500,003 pUSD out of the wallet and put nothing in.

## How it was counted

- **RN1** is the Polygon wallet `0x2005d16a84ceefa912d4e380cd32e7ff827875ea`.
- **Cash** is pUSD (`0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb`) and USDC.e (`0x2791bca1f2de4661ed88a30c99a7a9449aa84174`), in whole tokens.
- **Balance** is the wallet's `balanceOf` reading at block 91743314, plus every `Transfer` of the token into or out of the wallet since.
- **Trading** is a transfer in a transaction that also holds an `OrderFilled` of RN1's order, or a merge or redemption that names RN1.
- **Payment** is a pUSD transfer to RN1 in a transaction with none of those.
- **Withdrawal** is pUSD that RN1 unwrapped into USDC.e and then sent to another address.

## What the data shows

Where the pUSD went (`_by_kind`, `_balance`):

| | Transfers | pUSD |
|---|---:|---:|
| Held before the first block | | 1,115,926.995746 |
| Paid for shares, with fees | 920,224 | −223,143,455.696213 |
| Paid out by redemptions | 62,242 | +221,667,910.865300 |
| Paid out by merges | 435 | +3,037,175.656637 |
| Paid to it outside its trades | 297 | +935,443.112500 |
| Unwrapped and sent away | 7 | −1,500,003.000000 |
| Held after the last block | | 2,112,997.933970 |

- **The balance's range** (`_balance`): lowest 167,865.487331 pUSD at 2026-09-08 04:00:16 UTC, highest 2,612,153.621278 at 2026-10-28 05:38:17 UTC. The wallet held no USDC.e at either end.
- **Payers** (`_payers`): four addresses paid all but 80.51 pUSD.
  - `0xfdb1b8dc7f5789a0c9a398026585b8b10fba5507`: 471,219.0185 pUSD on 92 days.
  - `0x520bf77d9d34c34a6a9723f50e1dcb887ed238c5`: 321,532.2228 pUSD on 92 days.
  - `0x2c2795ea295d5eb51f9121b728ed2ea4e936a709`: 113,989.1677 pUSD on 60 days.
  - `0xd152f549545093347a162dce210e7293f1452150`: 28,622.19 pUSD on 4 days.
- **What the payments follow** (`_payments_by_day`): the second payer's amount is 50.0% of the taker fees RN1 paid the day before, on at least 8 days in 10 of the 91 compared. The first payer's amount moves with the pUSD RN1 bought as maker the day before: a median 0.268% of it.
- **Withdrawals** (`_withdrawals`): seven transfers on 2026-08-31, 2026-10-01 and 2026-10-28, all to `0x4cd00e387622c35bddb9b4c962c136462338bc31`. Each day began with 1 pUSD; the large ones were 250,000, 250,000, 500,000 and 500,000.
- **Merges** (`_merges`): the two large merge sweeps began with 194,748 and 195,984 pUSD in the wallet.

## The data

- Chain and blocks: Polygon, 91743315 to 97042228.
- Inputs, last loaded (UTC): `polygon.erc20_transfers` 2026-11-12 17:41, `polygon.erc20_balances` 2026-11-12 17:30, `polygon.polymarket_ctf_exchange_v2` 2026-11-12 03:46, `polygon.polymarket_ctf` 2026-11-12 03:46.
- Checks: dbt tests, dead letters, freshness and coverage passed. One upstream test warned, `polymarket_resolved_markets_are_zero_sum`, as it does for a warehouse that follows one wallet.
- The rebuilt balance equals the wallet's `balanceOf` reading at block 97042228.
- Cross-check: the Portal MCP and the mart both give 2 transfers in and 3 out over blocks 96000000 to 96000600.

## Caveats

- **Inferred, not observed:** that the payments are Polymarket's fee rebate and its rewards for resting orders. The chain shows who paid, how much and when, not why.
- A payment made to another wallet of the same operator would not show here. Nor does where the withdrawn USDC.e went next.
- Cash from trading (+1,561,630.83 pUSD) is not profit to payout. It counts payouts on shares bought before the window and leaves out shares not yet paid.
- `kind` tells trades apart only for CTF Exchange v2 fills and the position events the sources load. A Protocol V2 payout would read as a mint or a transfer; RN1 has no mint in the window.
- Counting only the four regular payers gives 935,362.60 pUSD, 80.51 less.
