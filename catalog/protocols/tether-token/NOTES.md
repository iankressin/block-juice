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
| `Transfer(from, to, value)` | none on Ethereum, also when `to` is the zero address | `transfer` |
| `Issue(amount)` | rises by `amount`, credited to the owner | `issuance` |
| `Redeem(amount)` | falls by `amount`, taken from the owner | `destruction` |
| `DestroyedBlackFunds(_blackListedUser, _balance)` | falls by `_balance`, taken from the user | `destruction` |

The two chains differ in how `issue` shows up:

- On Ethereum, `issue`, `redeem` and `destroyBlackFunds` emit only their own event, as `TetherToken.sol` reads and proof rows 1, 9 and 10 show. A reader that takes supply changes from zero-address Transfers misses all three.
- On TRON, `issue` emits `Issue(amount)` and then `Transfer(zero address, owner, amount)` in the same transaction (proof row 7). Counting both counts the issuance twice. `destroyBlackFunds` emits only `DestroyedBlackFunds` (proof row 3).

So a supply event and a zero-address Transfer of the same amount in the same transaction are one movement. When the pair exists, the Transfer row carries the movement, since it names the account, and the supply event is not counted again. When there is no pair, the supply event is the movement.

A Transfer to the zero address that pairs with no supply event:

- On Ethereum it parks tokens at that address and leaves `_totalSupply` alone. Proof row 8: `totalSupply()` is the same before and after the block, and `balanceOf(0x0)` rises by the amount.
- On TRON it is unproven. `balanceOf` of the zero address reads 0 on 2026-11-07, so either no such transfer happened or it burns tokens. The pipeline leaves `changes_supply` unset for it, which fails the day rather than guess.

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
| 3 | TRON | DestroyedBlackFunds | 86646549 | `08f6a2828b1799df4dfeb14945107c67da26db59e4298a19878531c4031d1a71` | tx 33, log 1 | `_blackListedUser` in topic1 (`b87e72d3b93c86af842a15c7a695275a316de659`), `_balance` 64740313520 in data (hex `0f12d2c9b0`). Logs 0 and 2 come from the owner multisig. No Transfer log in the transaction. |
| 4 | TRON | AddedBlackList | 86613171 | `72da056ee253ba4b0fef0b1b7f3f8fc53f9533e85b0a1086d92633afd580a9fc` | tx 80, log 1 | `_user` in topic1 (`f0d513a2bf18cec7672bd80df668c2a15983633b`), empty data. |
| 5 | Ethereum | AddedBlackList | 26136686 | `0xa8dafd10f768b389e069306cdea66b84243253f8ce6b129f5d9170a9e1243c2f` | 290 | `_user` `0x6c1aea2787cf3e78b519aa3e2f2d87e83b553c65` in data, no topic1. |
| 6 | TRON | Transfer | 87806000 | `956e3b1eabad3f790d9a307872027df2f026216b071cb3e82b87f5a46e198234` | tx 17, log 0 | `from` `307a2ce4268229804bb6da26061b2cd6fa8d946c`, `to` `7ee06399c84eb819a7f4a07bc979de303563d9bd` in topics, `value` 560000000 in data; transaction `result` SUCCESS. |
| 7 | TRON | Issue and its Transfer | 80864600 | `c042590c43d0d6f8b34335707a985e29cd46acea68f1296f2bee5e0185084f5b` | tx 203, logs 1 and 2 | Log 1 is `Issue(1000000000000000)`. Log 2 is `Transfer` from the zero address (`T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`) to the owner multisig (`TBPxhVAsuzoFnKyXtc1o2UySEydPHgATto`) of the same 1000000000000000. Logs 0 and 3 come from the multisig. |
| 8 | Ethereum | Transfer to the zero address | 25504335 | `0x3769e5e46f0585ee5b1f843584451662b588710cf0a53356a33453472d45e5e6` | 587 | 65000000 from `0xc7a41d4e631efd28c2b6af3435f61062172b0e7b` to `0x0000000000000000000000000000000000000000`. `totalSupply()` is 92062996230909656 at 25504334 and at 25504335; `balanceOf(0x0)` goes from 1033641401722 to 1033706401722. |
| 9 | Ethereum | Issue | 22376454 | `0xb85b28370e9a56942347df4a8704b3a4a4faf723aeb12702fe28bdccd15251f5` | 656 | `Issue(1000000000000000)` is the transaction's only token log. `totalSupply()` goes from 72548246174880820 to 73548246174880820, up by the amount. |
| 10 | Ethereum | Redeem | 22254980 | `0x9a41764e1d05a9d32104d704d36699b846b562ee564c715ffe8f5f67a5d4496b` | 450 | `Redeem(1800000000000000)` is the transaction's only token log. `totalSupply()` goes from 75888082398883907 to 74088082398883907, down by the amount. |

## Search ranges

- Ethereum, admin events (everything but Transfer and Approval): blocks 26100000 to 26366000.
- Ethereum, `Issue` and `Redeem`: blocks 22000000 to 22377625, where the scan stopped after four hits.
- TRON, admin events: blocks 86600000 to 87806000.
- TRON, `Issue`, `Redeem`, `Params` and `Deprecate`: blocks 80000000 to 84994185. Five `Issue` logs and no `Redeem`, so TRON's `Redeem` shape is unproven. The pipeline handles a Redeem either way: paired with a Transfer to the zero address, or alone.
- TRON, Transfers to the zero address: blocks 80000000 to 82679692. None found.
