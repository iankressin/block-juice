# Tether token on Ethereum and TRON: notes

These notes cover the events in `protocol.yaml`. Every address, topic and block below comes from SQD Portal (`ethereum-mainnet`, `tron-mainnet`), from block-pinned reads over an archive RPC or TronGrid, or from the pages listed in `protocol.yaml`. The proof table at the end ties each rule to real logs.

## Two contracts, two ABIs

Both deployments are Tether's `TetherToken`. They share event names and topic0s, but not which arguments are indexed:

| Event | Ethereum | TRON |
|---|---|---|
| `DestroyedBlackFunds(_blackListedUser, _balance)` | both in data | `_blackListedUser` indexed (topic1), `_balance` in data |
| `AddedBlackList(_user)`, `RemovedBlackList(_user)` | in data | indexed (topic1) |
| `OwnershipTransferred(previousOwner, newOwner)` | not in the contract | both indexed |

Decode each chain's logs with its own ABI file. Copying the Ethereum ABI onto TRON drops the blacklisted address, because the decoder looks for it in data. The TRON ABI is the one TronGrid's `wallet/getcontract` returns for `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, and proof rows 3 and 4 show the indexed address on real logs.

## What changes supply

| Event | Effect on `totalSupply()` | Movement family |
|---|---|---|
| `Transfer(from, to, value)` | none, also when `to` is the zero address | `transfer` |
| `Issue(amount)` | rises by `amount`, credited to the owner | `issuance` |
| `Redeem(amount)` | falls by `amount`, taken from the owner | `destruction` |
| `DestroyedBlackFunds(_blackListedUser, _balance)` | falls by `_balance`, taken from the user | `destruction` |

`issue`, `redeem` and `destroyBlackFunds` emit only their own event, not a Transfer from or to the zero address. A reader that takes supply changes from zero-address Transfers misses all three. In `TetherToken.sol`, `transfer` and `transferFrom` move balances only, so a Transfer to the zero address parks tokens at that address and leaves `_totalSupply` alone.

Proof rows 1 and 2: on Ethereum every block in 26141941 to 26243188 that holds a `DestroyedBlackFunds` lowers `totalSupply()` by exactly the summed `_balance`, read at the block before and the block itself over an archive RPC. The supply did not move between those blocks otherwise, which also shows no `Issue` or `Redeem` landed there.

## Fees and deprecation

`transfer` can charge a fee of `basisPointsRate` basis points, capped at `maximumFee`. A non-zero fee emits a second `Transfer` from the sender to the owner, before the Transfer of the amount sent. With both set to zero there is no fee leg. `Params(feeBasisPoints, maxFee)` is emitted when the owner changes them. `deprecate(newAddress)` forwards every later call to an upgraded contract and emits `Deprecate`; logs would then come from the new address.

Read at the last block before 2026-10-08 00:00 UTC:

| Chain | Block | `basisPointsRate` | `maximumFee` | `deprecated` | `decimals` |
|---|---|---|---|---|---|
| Ethereum | 26143955 | 0 | 0 | false | 6 |
| TRON | the latest solidified block on 2026-11-07 (TronGrid serves no past state) | 0 | 0 | false | 6 |

A `Params` log with a non-zero fee, or any `Deprecate` log, means the rules here no longer hold from that block on. The pipeline fails those days instead of guessing.

## Keys and addresses

- Ethereum logs are unique by `<block>:<logIndex>`.
- TRON's `logIndex` restarts at 0 in every transaction. Block 87806000 holds 31 USD₮ logs with only two distinct log indexes. A TRON log is unique by `<block>:<transactionIndex>:<logIndex>`.
- Portal returns TRON addresses as 20-byte hex without `0x` (`a614f803b6fd780986a42c78ec9c7f77e6ded13c`). TRON's own form is Base58Check of `41` plus those bytes (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`). It is case-sensitive; never lowercase it.
- TRON block timestamps are milliseconds. Ethereum's are seconds.
- On TRON the owner is a multisig, `0fa695d6b065707cb4e0ef73b751c93347682bf2` in hex. Its own logs (submission and execution) sit beside the token's in the same transaction, which is why a TRON `DestroyedBlackFunds` has log index 1. A filter on the token's address leaves them out.

## Success

An Ethereum log exists only in a successful transaction. On TRON, Portal returns each log's transaction with `result` and `ret[0].contractRet`. Every USD₮ log checked (296 logs in blocks 87806000 to 87806009, and every log in the proof table) sits in a transaction whose `result` is `SUCCESS`. The pipeline still keeps only `SUCCESS` transactions on TRON, since that is the field TRON defines.

## Proof table

| # | Chain | Event | Block | Transaction | Log | What it shows |
|---|---|---|---|---|---|---|
| 1 | Ethereum | DestroyedBlackFunds | 26141941 | `0xf4e0ae5a855c22c6b16dd80aa74a394bedda4ac463ca9464a511090172b5a594` | 388 | `_blackListedUser` `0x4f87f64d1914c7032e4b40368b89b6c61e91a71c`, `_balance` 40010317298, both in data. `totalSupply()` 88303053982363963 at 26141940 and 88303013972046665 at 26141941: down 40010317298. |
| 2 | Ethereum | DestroyedBlackFunds | 26141942 | `0x6992467d0143f9198c2dbaf40d9f956bd1b57e7a5b2c23b437f08fe8edeac456`, `0x651dc7270bd171ddccd1bed43df2c9701c85e438b05af324f417bab06548d759` | 235, 238 | Two burns in one block, 154788031703 and 192075211110. `totalSupply()` falls by 346863242813, their sum. |
| 3 | TRON | DestroyedBlackFunds | 86646549 | `08f6a2828b1799df4dfeb14945107c67da26db59e4298a19878531c4031d1a71` | tx 33, log 1 | `_blackListedUser` in topic1 (`b87e72d3b93c86af842a15c7a695275a316de659`), `_balance` 64737020336 in data. Logs 0 and 2 come from the owner multisig. No Transfer log in the transaction. |
| 4 | TRON | AddedBlackList | 86613171 | `72da056ee253ba4b0fef0b1b7f3f8fc53f9533e85b0a1086d92633afd580a9fc` | tx 80, log 1 | `_user` in topic1 (`f0d513a2bf18cec7672bd80df668c2a15983633b`), empty data. |
| 5 | Ethereum | AddedBlackList | 26136686 | `0xa8dafd10f768b389e069306cdea66b84243253f8ce6b129f5d9170a9e1243c2f` | 290 | `_user` `0x6c1aea2787cf3e78b519aa3e2f2d87e83b553c65` in data, no topic1. |
| 6 | TRON | Transfer | 87806000 | `956e3b1eabad3f790d9a307872027df2f026216b071cb3e82b87f5a46e198234` | tx 17, log 0 | `from` `307a2ce4268229804bb6da26061b2cd6fa8d946c`, `to` `7ee06399c84eb819a7f4a07bc979de303563d9bd` in topics, `value` 560000000 in data; transaction `result` SUCCESS. |

## Search ranges

- Ethereum, admin events (everything but Transfer and Approval): blocks 26100000 to 26366000.
- TRON, admin events: blocks 86600000 to 87806000.
