# SPL Token on Solana: notes

These notes cover the instructions in `protocol.yaml`. Every account, slot and signature below comes from SQD Portal's `solana-mainnet` dataset or from the program source listed in `protocol.yaml`. The proof table at the end ties each rule to real transactions.

## What moves a token

A token account holds one mint for one owner. Four instruction families change a balance:

| Instruction | Discriminator | Moves | Accounts that carry the amount |
|---|---|---|---|
| `transfer` | 3 | `amount` from `source` to `destination` | 0 source, 1 destination |
| `transferChecked` | 12 | `amount` from `source` to `destination`; `decimals` must match the mint | 0 source, 2 destination; 1 is the mint |
| `mintTo`, `mintToChecked` | 7, 14 | new `amount` into `account`; supply rises | 0 mint, 1 account |
| `burn`, `burnChecked` | 8, 15 | `amount` out of `account`; supply falls | 0 account, 1 mint |

Amounts are u64 little-endian right after the one-byte discriminator, in the mint's base units. Plain `transfer` does not name the mint: the mint comes from the source or destination account. Every other row names it.

An instruction can be outer or inner. Portal gives each one an `instructionAddress`: `[2]` is the third outer instruction, `[2, 0]` the first inner instruction it called. Sorting by `(slot, transactionIndex, instructionAddress)` gives execution order, since an inner instruction runs inside its outer one and before the next.

A failed transaction keeps its instructions in Portal with `isCommitted: false` and leaves every balance as it was. Only transactions with `err` null move tokens.

## Who owns a token account

Portal returns one token balance record per transaction and tracked account, with `preOwner`, `postOwner`, `preAmount`, `postAmount`, `preDecimals` and `postDecimals`. That record gives the owner before and after the transaction. Inside one transaction the owner changes only through these instructions on the account:

- `initializeAccount` (owner is account 2), `initializeAccount2` and `initializeAccount3` (owner in the data) set the first owner.
- `setAuthority` with `authority_type` 2 (`AccountOwner`) names a new owner. Instructions before it keep the old one.
- `closeAccount` ends the account. A later `initializeAccount*` of the same address starts a new account that does not inherit the old owner.

So the owner at an instruction is `preOwner`, changed by each of those instructions that ran before it, in instruction order. After the last change it must equal `postOwner`; when it does not, the owner is unresolved. Joining on the slot alone is wrong: two transactions in one slot can see two owners.

## Accounts opened and closed in one transaction

Swaps often create an associated token account, use it and close it in the same transaction. Portal has no balance record for such an account, because it did not exist before or after. Its movements still show in the instructions: proof row 3 creates `8bvz95dRjJSdyoCpUKDcgNXV672RKUWScgrhYqg7odSX`, moves 310 base units in and out, and closes it. A reader that keeps only instructions touching accounts with a balance record would miss the `closeAccount` and could miss a `transfer` between two such accounts. Keep the instructions on accounts that a kept `initializeAccount*` created in the same transaction.

## Checking a transaction

For each successful transaction and each tracked account with a balance record, `postAmount - preAmount` equals the decoded movements into it minus those out of it. For each account without a balance record the decoded movements net to zero. On slots 466690000 to 466690049, 153 transactions touched the USD₮ mint: 22 failed and 131 succeeded, and all 131 pass this check.

## Proof table

| # | Rule | Slot | Tx index | Signature | What it shows |
|---|---|---|---|---|---|
| 1 | `transferChecked` | 466690001 | 79 | `65oJANohv12Ym6iYY6SXFnxzHMwzZbLPXmdzay7kif6BSopY1DCtdBKeX464v24UaZvLMNcmPuDjUDX6tK72wqmP` | 10 base units from `28dVY2zni2NeNrmABU7PA7SUWc3TsgRNGnHPd6oGUj3U` to `EtRPd5nq6mXLeQWim9JW4ubu6t6tQCGs4hKvazVG6rho`, outer instruction `[3]`. Both balance records move by 10. |
| 2 | inner `transfer` | 466690002 | 257 | `4B3hUsSNz4KvKPxzaiLP7T4ejvZJjGAVbgE8adwxfKz7A7LRfu8CaFrkDfrAAv3xi9EGX1rC8ee5yfxRCLGKXohG` | Three inner transfers at `[0,0]`, `[0,2]`, `[0,3]`: 2158719112 into `538rqKA39YEe7VnR2EznBixYeohfdNv4JTJB3cFamwr7`, then 431744 and 21155447 out of it. Each account's balance change equals its net. |
| 3 | account opened and closed in one transaction | 466690013 | 142 | `5w15ERfrCC3jNQey8sDGzzQ5C7a51pnF3J25SXoFmqJWyQ5TCKFF9p1P9QUKiS5Xde7AdH5P2xBBXRCW3n3phAma` | `initializeAccount3` of `8bvz95dRjJSdyoCpUKDcgNXV672RKUWScgrhYqg7odSX` at `[0,3]`, `transferChecked` of 310 into it at `[1]` and out of it at `[2]`, `closeAccount` at `[3]`. No balance record for `8bvz…`; `9gcX2jPSMPE3bqPG6FdB8xQbKJ9HBCii7hFmKVbr7HPM` falls by 310 and `EMzMxsWCPuJpx5iJgh2PK3zDTS3V9dZHJzH7PujJs2oc` rises by 310. |
| 4 | failed transaction moves nothing | 466690001 | 54 | `26wkcPKrRrMbN2ZoYfoDfWmabjBvihYA7XNdkdNLJKDBYenNkcm8d6fgn8bL2rifYMRjXUAmLSmexNvuEbhmDREJ` | `err` is `{"InstructionError": [0, {"Custom": 6001}]}`, its token instructions have `isCommitted: false`, and both tracked balances keep their amounts. |
| 5 | owner from the balance record | 466690001 | 54 | as row 4 | `85WU4DGuDQL1Mc8m4EZg1rsc5hWdni5hH6MmpxBAQ8Yh` has `preOwner` = `postOwner` = `DjYqetGx4i2EskcTnZpZPQDKDLu61w6582Eqz4xPdphF`, the same address its `transfer` at `[0,2,0]` names as authority. |

| 6 | `burn` | 440009884 | 224 | `5qPDSnGvYtJ3Cb5uJ4fYgebF8KhC1yPE4cqX9qadbF5GAQ7fvY6qaHuhbn2a9bwPgn9rMVwXBAiLdvuPQNKvqopW` | Outer instruction `[2]`, discriminator 8, burns 9 base units from `8nnZLDVuWQXqDNuB3hsDxYrvCJ1DmoctphmK55aRdMNW`; account 1 is the mint. The account's balance falls by 9. The other 17 successful transactions of that slot reconcile too. |

No `mintTo` or `mintToChecked` of the USD₮ mint was found in the slots searched. That rule comes from the program source, and the tests that cover it use fixtures labeled as specification fixtures.

## Search ranges

- Transfers and balance checks: slots 466690000 to 466690049, and slot 440009884, each one Portal stream query with token balances filtered by `preMint` and `postMint`.
- Mints and burns: SPL Token instructions with discriminator 7 or 14 and account 0 equal to the mint, or 8 or 15 and account 1 equal to the mint, slots 440000000 to 440047272. Seven burns, no mints.
