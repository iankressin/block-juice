# question.yaml

`answers/<slug>/question.yaml` says what an answer counts, over which data. `bj answer` reads it and refuses a key it does not know.

| Key | Required | What it holds |
|---|---|---|
| `question` | yes | The user's question, in their words. |
| `asked` | no | The date the user asked, `YYYY-MM-DD`. Resolve "last month" or "now" against it. |
| `definitions` | no | Each word that could be counted two ways, mapped to the reading you used. |
| `alternatives` | no | Readings you passed over that would change the number. |
| `window` | no | The time span. `from` and `to` are UTC dates or times, and `to` is the first moment not counted: `from: 2026-10-08` and `to: 2026-11-07` count 8 October through 6 November. `blocks` holds the first and last block inside that span, both counted, as `bj blocks` prints them. On one chain, `chain` plus `blocks: [from, to]`. On several chains, `blocks` maps each chain to its range, `{arbitrum: [from, to], base: [from, to]}`. On TRON the numbers are block heights; on Solana they are slots. Use `at: latest` for a question about now. History inputs need blocks on their chain. |
| `inputs` | no | One entry per kind of data: `name`, `strategy` (`state` or `history`), and the `mart` that holds it. A history input names its `source` as `<chain>.<table>`, and may narrow it with `filter`, keyed like the source's `addresses.json`, with every address quoted. `bj answer` checks coverage for it, and fails it when the source's cursor is past Portal's finalized head. |
| `marts` | no | The marts the analyses read. |
| `analyses` | no | The dbt analyses to run, headline first. Defaults to the slug with `_` for `-`. |

A question about now, answered from an existing mart:

```yaml
question: How much ETH do the tracked wallets hold right now?
asked: 2026-11-04
definitions:
  tracked wallets: The wallets in ingestion/sources/evm-eth-balances/chains/ethereum/addresses.json
  right now: Each wallet's latest balance reading
window:
  chain: ethereum
  at: latest
inputs:
  - name: eth_balances
    strategy: state
    mart: latest_balances
marts: [latest_balances]
analyses: [tracked_wallets_eth, tracked_wallets_eth_by_wallet]
```

A question over a past month that needs history, which `bj` cannot load yet:

```yaml
question: How many wallets bought PEPE on Ethereum last month?
asked: 2026-11-04
definitions:
  bought: Sent a DEX swap whose output token is PEPE
  wallet: The address that signed the swap transaction
alternatives:
  - Count swap recipients, not senders
  - Count every wallet that received PEPE, swap or not
window:
  chain: ethereum
  from: 2026-10-01
  to: 2026-11-01
  blocks: [26093738, 26316188]
inputs:
  - name: pepe_pools
    strategy: history
    protocol: uniswap
    events: [v2.PairCreated, v3.PoolCreated]
    filter: {token: PEPE}
    blocks: from_deployment
  - name: pepe_swaps
    strategy: history
    protocol: uniswap
    events: [v2.Swap, v3.Swap]
    filter: {contracts: pepe_pools}
    blocks: window
marts: [dex_trades]
```

## Window blocks

Take each chain's `blocks` from `bj blocks <chain> <from> <to>`. It prints the first block at or after `from` and the last block before `to`. Portal's time-to-block route, `/timestamps/<time>/block`, gives a guess, not a boundary, so never copy a block from it alone. On 7 November 2026 it put TRON blocks up to 45 minutes before the time asked, and a Solana slot for 8 October almost 19 hours after it. `bj blocks` starts from that guess and checks it against block timestamps. On Solana, both ends are slots that hold a block, never skipped ones.

A question over 30 days on three chains:

```sh
uv run --project orchestration bj blocks ethereum 2026-10-08 2026-11-07
uv run --project orchestration bj blocks tron 2026-10-08 2026-11-07
uv run --project orchestration bj blocks solana 2026-10-08 2026-11-07
```

```yaml
question: What share of USDT transfer volume moved on TRON from 8 October to 6 November 2026?
asked: 2026-11-07
window:
  from: 2026-10-08
  to: 2026-11-07   # the first day not counted
  blocks:
    ethereum: [26143956, 26359253]
    tron: [86914950, 87778634]
    solana: [454377023, 466302737]
inputs:
  - {name: ethereum_movements, strategy: history, mart: token_movements, source: ethereum.tether_token}
  - {name: tron_movements, strategy: history, mart: token_movements, source: tron.tether_token}
  - {name: solana_movements, strategy: history, mart: token_movements, source: solana.spl_token}
marts: [transfer_share, transfer_share_stage_daily]
analyses: [transfer_share_window, transfer_share_daily]
```
