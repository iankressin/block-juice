# OP Stack standard bridge on Base: notes

These notes cover the Base side of the OP Stack standard bridge, for SQD. Every address, topic and block below comes from SQD Portal data, from the OP specs and Base docs pages in `protocol.yaml`, or from the contract sources in the npm package `@eth-optimism/contracts-bedrock@0.17.3`. The proof table at the end ties each event to one real log.

SQD crosses this bridge by burn and mint. SQD on Base is `0xd4554BEa546EFa83C1E6B389ecac40EA999B3E78`, an OptimismMintableERC20 whose remote token is SQD on Ethereum, `0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1`. A deposit locks SQD in the L1StandardBridge on Ethereum, and the L2StandardBridge mints it on Base. A withdrawal burns SQD on Base, and the L1StandardBridge later releases SQD it holds.

## The two events a source needs

Both come from the L2StandardBridge predeploy `0x4200000000000000000000000000000000000010`.

### `ERC20BridgeInitiated(localToken, remoteToken, from, to, amount, extraData)`: a withdrawal to Ethereum started

| Field | Where | Meaning |
|---|---|---|
| `localToken` | topic1 | The Base token burned. SQD is `0xd4554bea...`. |
| `remoteToken` | topic2 | The Ethereum token to be released. SQD is `0x1337420d...`. |
| `from` | topic3 | The Base address whose tokens were burned: the L2 user. It is `msg.sender` of the bridge call (`bridgeERC20`, `bridgeERC20To`, `withdraw` or `withdrawTo`). |
| `to` | data word 0, not indexed | The Ethereum address that will receive the tokens: the L1 counterpart. |
| `amount` | data word 1 | Tokens burned, in base units. SQD has 18 decimals. |
| `extraData` | data | Bytes the caller attached. The bridge passes them on and does nothing with them. |

`from` is not always `tx.from`. When a contract calls the bridge, `from` is that contract. In the non-SQD withdrawal `0x4511bb368ded05e23fb2fa3ec3fbd4d79f0092c93bb17ba55f905a6cfce4f3c8` (Base block 52307679), `tx.from` is `0xc94929d14435d80dd04b3206bfea9f5debabd57a`, `from` is `0x2Fb9ef510f1c52fdfDf84dfa8EEa72E431B7651D` and `to` is a third address, `0x6508eF65b0Bd57eaBD0f1D52685A70433B2d290B`.

### `ERC20BridgeFinalized(localToken, remoteToken, from, to, amount, extraData)`: a deposit from Ethereum finished

| Field | Where | Meaning |
|---|---|---|
| `localToken` | topic1 | The Base token minted. |
| `remoteToken` | topic2 | The Ethereum token locked. |
| `from` | topic3 | The Ethereum address that sent the deposit: the L1 counterpart. It is `msg.sender` of the L1StandardBridge call. It travels inside the message, so it is not aliased. `depositERC20` and `bridgeERC20` on Ethereum accept only EOAs, but `depositERC20To` and `bridgeERC20To` accept contracts, so `from` can be a contract. |
| `to` | data word 0, not indexed | The Base address that received the minted tokens: the L2 user. |
| `amount` | data word 1 | Tokens minted, in base units. |

`tx.from` of a deposit transaction is normally not a user. When the L1 messenger delivers the deposit, `tx.from` is `0x977F82a600a1414E583f7F13623F1ac5D58B1C0b`, the L1CrossDomainMessenger's address plus `0x1111000000000000000000000000000000001111` (the alias rule in `AddressAliasHelper.sol`). `tx.to` is the L2CrossDomainMessenger and the call is `relayMessage`. If that call fails, the messenger marks the message failed and anyone can replay it later. The event then lands in the replay transaction, with the replayer as `tx.from`.

### Legacy twins: do not load both

For every ERC-20 bridge, the L2StandardBridge emits a legacy event just before the new one, with the same values and the two tokens in the other order:

- `WithdrawalInitiated(l1Token, l2Token, from, to, amount, extraData)` before `ERC20BridgeInitiated` (proof rows 4 and 5).
- `DepositFinalized(l1Token, l2Token, from, to, amount, extraData)` before `ERC20BridgeFinalized` (proof rows 1 and 2).

Loading both counts every transfer twice. This entry picks the `ERC20Bridge*` pair because the contract source tags the other two events `@custom:legacy`, and the legacy `withdraw` functions say they are "Subject to be deprecated in the future". The package's L2StandardBridge is version 1.10.0. Base may run another version, but the topic0s above match Base's logs. The legacy events also fire for ETH, with `l1Token` the zero address and `l2Token` `0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000`. A token filter drops those.

## Filtering on SQD

- Withdrawals: `address = l2_standard_bridge`, `topic0 = ERC20BridgeInitiated`, `topic1 = 0x000000000000000000000000d4554bea546efa83c1e6b389ecac40ea999b3e78`.
- Deposits: the same with `topic0 = ERC20BridgeFinalized`.

The bridge mints or burns an OptimismMintableERC20 only after checking that the other token is that token's `remoteToken()`. So with `topic1` set to Base SQD, `remoteToken` is always L1 SQD. Never filter on `topic2` alone. The OptimismMintableERC20Factory lets anyone create another Base token whose remote token is L1 SQD, and a depositor on Ethereum names the Base token to mint.

OptimismMintableERC20 lets only its `BRIDGE` mint and burn. If `0xd4554bea...` runs that code, every SQD mint or burn on Base is a bridge deposit or withdrawal. I did not compare its bytecode. Its `Mint` log in proof row 1 has the OptimismMintableERC20 topic0, and the L2StandardBridge's `mint` call succeeded.

## Delay before a withdrawal reaches Ethereum

Base's Withdrawals page lists three steps. The withdrawal is sent on Base, which records it in the L2ToL1MessagePasser (event `MessagePassed`). Once the Base state is posted to Ethereum, "anyone can submit a proof to the `OptimismPortal` contract". After the finalization window, "anyone can finalize the withdrawal on Ethereum". The window is "5 days for a single-proof dispute game and 1 day on the dual-proof fast path", the fast path applying "when both a TEE proof and a ZK proof back the same proposal". Posting the state "usually adds only about 20 to 60 minutes". The Transaction Finality page gives the same 5 days or 1 day. The Withdrawals page says the Beryl upgrade brought these windows but gives no date, and the Base events do not say which window applied to a given withdrawal. The OP docs page gives 7 days, but for OP Mainnet.

Deposits are quick. The Transaction Finality page says deposits "typically get included within 3 minutes by the Base sequencer". The proof deposit landed on Base 2 minutes 56 seconds after its Ethereum transaction.

## Pairing an Arbitrum withdrawal with a Base deposit

The Arbitrum event is `WithdrawalInitiated` from the L2 custom gateway (see `../arbitrum-token-bridge/NOTES.md`, which has the full rules and limits). Pair it with a Base `ERC20BridgeFinalized` when:

1. Arbitrum `_to` (topic2) equals Base `from` (topic3): the same Ethereum address.
2. Arbitrum `_amount` equals Base `amount`.
3. The Base deposit comes at least 6.4 days after the Arbitrum withdrawal, the challenge period the Arbitrum docs give.
4. Each withdrawal and each deposit is used once.

Proof row 1 and the Arbitrum withdrawal of 2026-10-02 form such a pair, and Ethereum shows SQD passing through the address in between. The other two October SQD deposits on Base (see the search table below) do not match that withdrawal's amount.

| Step | Chain, block, time (UTC) | Transaction | What happened |
|---|---|---|---|
| Withdrawal starts | Arbitrum 511073531, 2026-10-02 18:55:09 | `0x82caf045a839ba52684cddfa460aca8835ab4f87203645c367ef8392e4be0cd3` | `0x8100...cfab9` burns 74779634313900000000000 SQD, `_to` = `0x8100...cfab9` |
| Withdrawal released | Ethereum 26154524, 2026-10-09 11:22:35 | `0x99ac0339c001e332c474ace53b87f3d3b535b91a44fd8d189dc72b78adc4a28c` | SQD log 360 moves 74779634313900000000000 from the Arbitrum L1 custom gateway to `0x8100...cfab9` |
| Deposit to Base starts | Ethereum 26154534, 2026-10-09 11:24:35 | `0xc6637b55c26355d9bd783e3cb36d9ea44dfe592ecbace52a76bb829dcbc43626` | `0x8100...cfab9` calls `depositERC20To` on the L1StandardBridge; SQD log 792 moves 74779634313900000000000 into the bridge |
| Deposit finishes | Base 52377952, 2026-10-09 11:27:31 | `0x2fb11026d686cfb54f09b9178e582095d38f79b01e4e0383f70930323cc2f8d4` | `ERC20BridgeFinalized`, `from` = `to` = `0x8100...cfab9` |

`0x8100...cfab9` is `0x81004f46e7fda526bd49529b544011dad06cfab9`.

The match cannot prove that the SQD deposited is the SQD withdrawn, since the Ethereum address can hold other SQD. It cannot show that the withdrawal was released before the deposit without Ethereum data, and it misses moves that split amounts, change addresses, or use exchanges and third-party bridges. It links two L2 addresses through one Ethereum address, which can be a contract acting for someone else. Equal amounts can also match by chance.

## SQD withdrawals on Base: none found

No SQD withdrawal from Base turned up, so proof rows 4 to 6 use another token's withdrawal, which shows the same event layout. I looked for SQD `Transfer` logs to or from the zero address on Base (the bridge's burns and mints) through the Portal stream API over:

| Blocks | Dates (UTC) | Burns | Mints |
|---|---|---|---|
| 49400000 to 52011726 | 2026-08-01 13:02 to the end of 2026-09-30 | 0 | 1: block 51667944, `0xde0ff01458bbf56860b5bfa9113ba6645dd36dc71a80067415939bf9b55abe92`, 11139711983040000000000 to `0x8100...cfab9` |
| 52011727 to 53350926 | October 2026 | 0 | 3, all to `0x8100...cfab9`: block 52377952 (proof row 1, 74779634313900000000000), block 52638880 (`0x557585f3ba0ff8626fe5658cd5f7cde4a7e8aa2cd3c422f05338ae60e91b7ada`, 195811479337750000000000), block 53073988 (`0xb631085722c02e40bb2a3a8b70f2350f98d2211e449c165a991a8717dad83683`, 60191171936330000000000) |
| 53350927 to 53554028 | 2026-11-01 00:00:01 to 2026-11-05 16:50:03 | 0 | 0 |

I did not search before 2026-08-01 and did not find the token's deploy block.

## Proof table

Each row is one log fetched from SQD Portal for `base-mainnet` through the Portal stream API with the `transaction` and `transactionLogs` options, so the rest of each transaction's logs and its input came back too. Rows 1 to 3 came from a filter on SQD's `Transfer` topic in block 52377952. Rows 4 to 6 came from a filter on the L2StandardBridge and `ERC20BridgeInitiated` over blocks 52300000 to 52310000, which returned five withdrawals, none of SQD. Decoding used the ABI files in `abis/`, taken from `L2StandardBridge.json`, `L2CrossDomainMessenger.json` and `L2ToL1MessagePasser.json` in `@eth-optimism/contracts-bedrock@0.17.3`. Each `topic0` in `protocol.yaml` is the keccak-256 of the signature built from those ABIs, and each matches the log's topic0.

| # | Event | Block | Transaction | Log | Decoded fields | How the decoding was confirmed |
|---|---|---|---|---|---|---|
| 1 | ERC20BridgeFinalized | 52377952 | `0x2fb11026d686cfb54f09b9178e582095d38f79b01e4e0383f70930323cc2f8d4` | 3 | localToken `0xd4554BEa546EFa83C1E6B389ecac40EA999B3E78`, remoteToken `0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1`, from = to = `0x81004f46E7fDA526bD49529b544011DaD06cFab9`, amount 74779634313900000000000, extraData `0x` | SQD Transfer log 0 mints 74779634313900000000000 from the zero address to `to`, and log 1 is the token's `Mint` for the same account and amount. `tx.from` is the L1CrossDomainMessenger's aliased address. The input decodes as `relayMessage` with `_sender` the L1StandardBridge `0x3154Cf16...` and `_target` the L2StandardBridge, and its message as `finalizeBridgeERC20` with the same tokens, addresses and amount. On Ethereum, SQD log 792 in block 26154534 moves the same amount from `from` into the L1StandardBridge. |
| 2 | DepositFinalized (legacy) | 52377952 | same | 2 | l1Token `0x1337420d...`, l2Token `0xd4554bea...`, from = to = `0x8100...`, amount 74779634313900000000000 | Same values as row 1, tokens in the other order. |
| 3 | RelayedMessage | 52377952 | same | 4 | msgHash `0xf5db008722e8ab9f4d5b3e44e74f1680a3d777538420c7551ec194aeee1a1a63` | The keccak-256 of the transaction's `relayMessage` calldata equals `msgHash`, as `Hashing.hashCrossDomainMessageV1` defines it. The nonce carries version 1. |
| 4 | ERC20BridgeInitiated (not SQD) | 52303402 | `0x94bc556f38e68efe199a551ab9d9cef8b08a8ac649a6758708c97515a2be143a` | 383 | localToken `0xc3De830EA07524a0761646a6a4e4be0e114a3C83`, remoteToken `0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984`, from = to = `0x4c02668Ee6E3cc91523ba9127335d39dc6209478`, amount 1432207531385648751871, extraData `0x` | Transfer log 380 burns 1432207531385648751871 of `0xc3De830E...` from `from` to the zero address, and log 381 is that token's `Burn`. `tx.from` is `from`, `tx.to` is the L2StandardBridge, and the input selector `0x32b7006d` is `withdraw(address,uint256,uint32,bytes)`. Row 6 carries the same values to Ethereum. |
| 5 | WithdrawalInitiated (legacy) | 52303402 | same | 382 | l1Token `0x1f9840a8...`, l2Token `0xc3De830E...`, from = to = `0x4c02668E...`, amount 1432207531385648751871 | Same values as row 4, tokens in the other order. |
| 6 | MessagePassed | 52303402 | same | 384 | sender `0x4200000000000000000000000000000000000007`, target `0x866E82a600A1414e583f7F13623F1aC5d58b0Afa`, value 0, gasLimit 288648, withdrawalHash `0x795683b3fa9e8552f3ba2f4513bf038bd879c82acf3c0989ff9ed5318091836c` | `withdrawalHash` equals keccak-256 of `abi.encode(nonce, sender, target, value, gasLimit, data)`, as `Hashing.hashWithdrawal` defines it. The target is the L1CrossDomainMessenger on the Base contracts page. `data` decodes as `relayMessage` from the L2StandardBridge to the L1StandardBridge `0x3154Cf16...`, carrying `finalizeBridgeERC20(0x1f9840a8..., 0xc3De830E..., 0x4c02668E..., 0x4c02668E..., 1432207531385648751871, 0x)`. |

## Time window used for checks

October 2026 on Base is blocks 52011727 to 53350926, from `answers/sqd-net-accumulators/question.yaml`.
