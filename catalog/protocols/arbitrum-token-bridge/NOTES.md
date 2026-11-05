# Arbitrum One token bridge: notes

These notes cover the L2 side of Arbitrum One's canonical token bridge, for SQD. Every address, topic and block below comes from SQD Portal data, from the Arbitrum docs pages in `protocol.yaml`, or from the contract sources in the npm packages `@arbitrum/token-bridge-contracts@1.2.5` and `@arbitrum/nitro-contracts@1.1.1`. The proof table at the end ties each event to one real log.

SQD crosses this bridge by burn and mint. A withdrawal burns SQD on Arbitrum, and the L1 custom gateway later releases SQD it holds on Ethereum. A deposit locks SQD in the L1 custom gateway, and the L2 custom gateway mints it on Arbitrum. The SQD token has the same address on both chains, `0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1`, and the events report that address as `l1Token`.

## The two events a source needs

Both come from the L2 custom gateway `0x096760F208390250649E3e8763348E783AEF5562`. The router's `TransferRouted` (proof row 1) shows that the router hands SQD to this gateway.

### `WithdrawalInitiated(l1Token, _from, _to, _l2ToL1Id, _exitNum, _amount)`: a withdrawal to Ethereum started

| Field | Where | Meaning |
|---|---|---|
| `l1Token` | data word 0, not indexed | The token's Ethereum address. SQD is `0x1337420d...`. |
| `_from` | topic1 | The Arbitrum address whose SQD the gateway burned: the L2 user. The gateway sets it to `msg.sender`, or to the caller the router passed on when the call came through the router. |
| `_to` | topic2 | The Ethereum address that will receive the SQD: the L1 counterpart. |
| `_l2ToL1Id` | topic3 | The withdrawal's id. It equals `position` in the ArbSys `L2ToL1Tx` log of the same transaction (proof row 3). |
| `_exitNum` | data word 1 | The gateway's running count of exits. It is also encoded in the message to Ethereum. |
| `_amount` | data word 2 | SQD burned, in base units (18 decimals). Ethereum releases exactly this amount. |

`tx.from` is whoever signed the Arbitrum transaction. It is the L2 user when the user calls the router or gateway directly (proof row 1), but a contract or a relayer can sit in between. Use `_from`, not `tx.from`.

### `DepositFinalized(l1Token, _from, _to, _amount)`: a deposit from Ethereum finished

| Field | Where | Meaning |
|---|---|---|
| `l1Token` | topic1 | The token's Ethereum address. |
| `_from` | topic2 | The Ethereum address that sent the deposit: the L1 counterpart. The L1 gateway takes it from the L1 router, which passes on its own `msg.sender`. It is not aliased. |
| `_to` | topic3 | The Arbitrum address that received the minted SQD: the L2 user. |
| `_amount` | data word 0 | SQD minted, in base units. |

`tx.from` of a deposit transaction is not a user. In all three October deposits to `0x8100...` it is `0xdFf384F754E854890E311e3280B767F80797291e`, the L1 custom gateway's address plus `0x1111000000000000000000000000000000001111` (the alias rule in `AddressAliasHelper.sol`), and `tx.to` is the L2 custom gateway.

## Filtering on SQD

- Deposits: `address = l2_custom_gateway`, `topic0 = DepositFinalized`, `topic1 = 0x0000000000000000000000001337420ded5adb9980cfc35f8f2b054ea86f8ab1`.
- Withdrawals: `l1Token` is not indexed, so the query cannot filter on it. Query `address = l2_custom_gateway`, `topic0 = WithdrawalInitiated` and keep rows whose decoded `l1Token` is SQD. That returns every custom-gateway token's withdrawals. I did not measure how many that is per month. To let Portal filter on the token instead, query SQD's own `Transfer` logs on Arbitrum with `topic2` = the zero address and `transactionLogs: true`, then take the gateway's `WithdrawalInitiated` from each transaction. That only works while every SQD burn on Arbitrum goes through the gateway, which held for October but which these events cannot promise.
- Do not use `TransferRouted` alone. A user can call the gateway directly, and then the router emits nothing.
- Do not filter `WithdrawalInitiated` by topic0 alone. The standard gateway `0x09e9222E96E7B4AE2a407B98d48e330053351EEe` emits the same topic0.
- Drop `WithdrawalInitiated` rows whose `_from` is the gateway itself. The gateway emits one when a deposit names a token it cannot mint, to send the tokens back to the L1 sender. No user started those.

## Delay before a withdrawal reaches Ethereum

The Arbitrum withdrawal guide says "Withdrawals require 6.4 days to finalize due to the challenge period". After that someone must call `Outbox.executeTransaction` on Ethereum. Nothing runs it on its own, and anyone may send it. So a withdrawal arrives no sooner than about 6.4 days after `WithdrawalInitiated`, and possibly much later.

The proof withdrawal took 6 days 16 hours 27 minutes from the Arbitrum burn (block 511073531, 2026-10-02 18:55:09 UTC) to the release on Ethereum (block 26154524, 2026-10-09 11:22:35 UTC).

## Pairing an Arbitrum withdrawal with a Base deposit

On Base the matching event is `ERC20BridgeFinalized` from the L2StandardBridge (see `../op-standard-bridge/NOTES.md`). Its `from` (topic3) is the Ethereum address that sent the deposit.

Pair an Arbitrum `WithdrawalInitiated` with a Base `ERC20BridgeFinalized` when all of these hold:

1. Arbitrum `_to` equals Base `from`: the same Ethereum address.
2. Arbitrum `_amount` equals Base `amount`. Neither bridge's code takes anything out of the token amount, and the proof pair below matches to the last base unit.
3. The Base deposit comes at least 6.4 days after the Arbitrum withdrawal. An earlier deposit cannot have been paid for by that withdrawal.
4. Each withdrawal and each deposit is used once. When several withdrawals fit one deposit, the data cannot say which one paid for it. Pick one rule, for example the latest withdrawal that is old enough, and report how many deposits had more than one candidate.

### The paired transfer on Ethereum

The proof withdrawal and the Base deposit of 2026-10-09 form such a pair, and Ethereum shows the SQD passing through the same address:

| Step | Chain, block, time (UTC) | Transaction | What happened |
|---|---|---|---|
| Withdrawal starts | Arbitrum 511073531, 2026-10-02 18:55:09 | `0x82caf045a839ba52684cddfa460aca8835ab4f87203645c367ef8392e4be0cd3` | `0x8100...cfab9` burns 74779634313900000000000 SQD, `_to` = `0x8100...cfab9` |
| Withdrawal released | Ethereum 26154524, 2026-10-09 11:22:35 | `0x99ac0339c001e332c474ace53b87f3d3b535b91a44fd8d189dc72b78adc4a28c` | `0x8100...cfab9` calls the Outbox `executeTransaction`; SQD log 360 moves 74779634313900000000000 from the L1 custom gateway to `0x8100...cfab9` |
| Deposit to Base starts | Ethereum 26154534, 2026-10-09 11:24:35 | `0xc6637b55c26355d9bd783e3cb36d9ea44dfe592ecbace52a76bb829dcbc43626` | `0x8100...cfab9` calls the L1StandardBridge `depositERC20To`; SQD log 792 moves 74779634313900000000000 from `0x8100...cfab9` into the bridge |
| Deposit finishes | Base 52377952, 2026-10-09 11:27:31 | `0x2fb11026d686cfb54f09b9178e582095d38f79b01e4e0383f70930323cc2f8d4` | `ERC20BridgeFinalized`, `from` = `to` = `0x8100...cfab9`, 74779634313900000000000 SQD minted |

`0x8100...cfab9` is `0x81004f46e7fda526bd49529b544011dad06cfab9`. The Ethereum rows came from Portal's `ethereum-mainnet` dataset, SQD `Transfer` logs filtered on the L1 custom gateway as sender or the L1StandardBridge as receiver over blocks 26151122 to 26154700.

### What the pairing cannot prove

- That the SQD deposited is the SQD withdrawn. The Ethereum address can hold other SQD, and tokens are fungible. Only the Ethereum leg, as in the table above, shows the release and the deposit in order, and even that does not tell one token unit from another.
- That the withdrawal was released before the deposit. The release is a separate Ethereum call that can come days or weeks late. Without Ethereum data, a deposit 7 days later may have used other SQD.
- Moves that change the amount or the address. A withdrawal split into two deposits, a deposit that adds SQD from elsewhere, or SQD that passes through an exchange or a second wallet on Ethereum will not match.
- Who the person is. The match links two L2 addresses through one Ethereum address. Arbitrum `_from` and Base `to` can differ, and the Ethereum address can be a contract, such as a multisig, that acts for someone else.
- Chance matches. Two unrelated transfers can share an address and amount. Round amounts make that more likely.
- Moves outside the canonical bridges. Third-party bridges and exchanges move SQD between chains without these events.

The reverse direction works the same way: a Base `ERC20BridgeInitiated` `to` (data word 0) against an Arbitrum `DepositFinalized` `_from` (topic2), with Base's own delay (see the Base notes).

## Proof table

Each row is one log fetched from SQD Portal for `arbitrum-one` through the Portal stream API, with a filter on SQD's `Transfer` topic and the `transaction` and `transactionLogs` options, so the rest of each transaction's logs and its input came back too. Decoding used the ABI files in `abis/`, taken from `L2CustomGateway.json` and `L2GatewayRouter.json` in `@arbitrum/token-bridge-contracts@1.2.5` and `ArbSys.json` in `@arbitrum/nitro-contracts@1.1.1`. Each `topic0` in `protocol.yaml` is the keccak-256 of the signature built from those ABIs, and each matches the log's topic0. Amounts are SQD base units (18 decimals).

| # | Event | Block | Transaction | Log | Decoded fields | How the decoding was confirmed |
|---|---|---|---|---|---|---|
| 1 | TransferRouted | 511073531 | `0x82caf045a839ba52684cddfa460aca8835ab4f87203645c367ef8392e4be0cd3` | 7 | token `0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1`, _userFrom = _userTo = `0x81004f46E7fDA526bD49529b544011DaD06cFab9`, gateway `0x096760F208390250649E3e8763348E783AEF5562` | The transaction input decodes as router `outboundTransfer(0x1337420d..., 0x8100..., 74779634313900000000000, 0x)`. The withdrawal guide passes the parent-chain token address to that call. The gateway is the "L2 Arb-Custom Gateway" on the addresses page. |
| 2 | L2ToL1Tx | 511073531 | same | 9 | caller `0x096760F2...` (L2 custom gateway), destination `0xcEe284F754E854890e311e3280b767F80797180d`, position 166568, arbBlockNum 511073531, ethBlockNum 26106562, callvalue 0. `data` is `finalizeInboundTransfer(0x1337420d..., 0x8100..., 0x8100..., 74779634313900000000000, data)` with exit number 20235 inside. | `data` decodes with the `L1CustomGateway` ABI. The destination is the "L1 Arb-Custom Gateway" on the addresses page. |
| 3 | WithdrawalInitiated | 511073531 | same | 11 | l1Token `0x1337420d...`, _from `0x8100...`, _to `0x8100...`, _l2ToL1Id 166568, _exitNum 20235, _amount 74779634313900000000000 | SQD Transfer log 8 burns 74779634313900000000000 from `0x8100...` to the zero address. `_l2ToL1Id` equals `position` in row 2 and `_exitNum` equals the exit number in row 2's `data`. On Ethereum, SQD log 360 in block 26154524 moves the same amount from the L1 custom gateway to `0x8100...` in a call to the Outbox. |
| 4 | DepositFinalized | 514745098 | `0xdde28a5f090286a005658cbf485c29acbd650400dd03841f4366871fb8ed82b7` | 3 | l1Token `0x1337420d...`, _from `0x8100...`, _to `0x8100...`, _amount 42169778142000000000000 | SQD Transfer log 2 mints 42169778142000000000000 from the zero address to `0x8100...`. `tx.from` is the L1 custom gateway's aliased address, `tx.to` is the L2 custom gateway, and the input decodes as `finalizeInboundTransfer` with the same token, addresses and amount. |

The other two October deposits to `0x8100...` decode the same way: block 514758465 (`0x10125b63005b5be92efb9b1121be5a07ef8a210e40f24f3fad27d00ce2d73d87`, 51540839951480000000000) and block 518149366 (`0x9552eddddcf365af8a8ca78dc5b5a63b48718ddf23800dcd332a044a9006e925`, 240764687743000000000000). In each, log 2 is the SQD mint and log 3 the `DepositFinalized` with the same amount.

## Time window used for checks

October 2026 on Arbitrum is blocks 510496864 to 520129273, from `answers/sqd-net-accumulators/question.yaml`. All proof rows fall inside it.
