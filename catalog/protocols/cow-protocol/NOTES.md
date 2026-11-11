# CoW Protocol: ETH Flow orders

## How an ETH Flow order moves

1. An EOA calls `createOrder` on the ETH Flow contract with ETH as call value. The call returns the GPv2 order hash and emits `OrderPlacement(sender = the EOA, order, signature, data)`. The order sells WETH (`sellToken`), and `validTo` is `2^32 - 1`: ETH Flow keeps the user's own expiry in `data` (8 bytes quote id, then 4 bytes expiry), not in the GPv2 order.
2. A solver settles it later, in its own transaction to GPv2Settlement. The settlement emits `Trade(owner = the ETH Flow contract, sellToken = WETH, buyToken, sellAmount, buyAmount, feeAmount, orderUid)` and transfers `buyAmount` of the buy token from itself to the order's `receiver`.
3. An order that is never settled can be refunded or invalidated by ETH Flow. Those events are not loaded; this repo calls such an order "not settled".

## The order UID

GPv2 keys an order by a 56-byte UID: the EIP-712 order hash (32 bytes), the owner (20 bytes) and `validTo` (4 bytes). Postgres has no keccak, so dbt does not hash the order. ETH Flow's `createOrder` returns the hash, and evm-cow-ethflow loads that call's trace output. `int_ethereum_cow_ethflow_orders` builds the UID as `output || eth_flow || lpad(hex(validTo), 8)`. The proof table below shows it equals the Trade's `orderUid`.

## Fields

- `sellAmount` in `Trade` is the executed sell amount and includes `feeAmount`. For the orders below `feeAmount` is 0.
- `buyAmount` in the `OrderPlacement` order is the minimum the user accepts. `buyAmount` in `Trade` is what the settlement paid.
- The ETH the user sent is the `createOrder` call value, which is also the top-level transaction's value when an EOA calls it directly.

## Readings the data tells apart, and those it does not

- **Sold vs. sent out:** an order whose UID appears in a later settlement Trade, which paid the receiver in the same transaction, filled. One with no such Trade did not, as of the loaded blocks.
- **Swap into what:** the Trade's `buyToken`. Whether a token is a stablecoin is a list (`transformation/seeds/stablecoins.csv`), not chain data.
- **Who triggered the sale:** not here. The settlement's `tx.from` is the solver.

## Proof table

| Event | Block | Transaction | What it shows |
|---|---|---|---|
| `createOrder` trace | 26380868 | `0x53ed2e9588f6ac402cb07bf83b230e57cd29ab788bb102d829940638dabefe36` | from `0x5cbc…2059`, value 1000 ETH, output `0x21249cf58047aacac4a79cb2bbadfa789758e6218dbb959cc26c3cbd90b05179` |
| `OrderPlacement` (log 266) | 26380868 | same | sender `0x5cbc…2059`, sell WETH 1000e18, buy USDS (`0xdc035d45…384f`) min 2116825418314008471811971, receiver `0x5cbc…2059`, validTo 4294967295 |
| `Trade` (log 155) | 26380873 | `0x4ccf0d2c0ee097dd9912fa37935e8dddfcd76eeab87615fd4b3a6dda636c48b3` | emitted by `0x9008…ab41`, owner ETH Flow, sellAmount 1000e18, buyAmount 2127112317765805877520044, orderUid `0x21249cf5…5179` + `ba3cb449…eadec` + `ffffffff` |
| `Transfer` (log 323) | 26380873 | same | USDS from `0x9008…ab41` to `0x5cbc…2059`, 2127112317765805877520044, equal to the Trade's buyAmount |
| `createOrder` / `OrderPlacement` (log 477) | 26385590 | `0xee0a81f6522ec67c5f347b4dc08a9e450fb95debfefc8ed0c3913bcc7ea747a0` | output `0xa5b76cf8…7bfc`, 1000 ETH, buy USDS |
| `Trade` (log 39) / `Transfer` (log 56) | 26385591 | `0xafac0fc91a9896a972a56949f21b7a7d8598598b04508a857001cfec2646b1f6` | orderUid `0xa5b76cf8…7bfc` + ETH Flow + `ffffffff`; USDS 2024875811627208703557632 to `0x5cbc…2059` |

The scope run of ticket #49 matched the same two orders to the same settlements by recomputing the EIP-712 digest over an archive RPC, independent of Portal.
