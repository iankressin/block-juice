**89.75%** of RN1's Polymarket fills from 10 August to 10 November 2026 were maker-side: its order rested on the book and someone else's order filled it.

RN1 only buys. In 911,860 fills it bought 463,569,293.462598 outcome shares for 222,503,015.363408 pUSD before fees, and sold nothing through the exchange. Every market with a known market record is a sports market, and 884,821 of the 911,157 fills in those markets came after the game started. In 42,273 of its 87,642 markets (48.23%) it bought both outcomes, and those pairs cost 0.984777 pUSD each on average after fees, which locks in 2,074,821.926145 pUSD, since a pair always pays exactly 1 pUSD. The shares left without a partner cost 88,890,743.764587 pUSD, 42.84 times that edge. Whether RN1 made money turns on those, and these results do not hold the payouts that would say.

Each finding below says whether the data shows it (**observed**), whether it is a reading of the data (**inferred**), or whether these results cannot answer it (**not answered**). The questions are the seven in issue #45.

## How it was counted

- **RN1** is the Polygon wallet `0x2005d16a84ceefa912d4e380cd32e7ff827875ea`.
- A **fill** is an `OrderFilled` log from the Polymarket exchange where RN1 is maker or taker. Each log is one fill, so one resting order that several takers fill counts more than once.
- A fill is **maker-side** when RN1's order rested on the book (role `maker` in the exchange's own log). The trade's direction plays no part.
- **pUSD** is Polymarket's collateral token, the unit of every amount here. Prices are pUSD per share.
- A **pair** is one share of each outcome of a two-outcome market. It merges or redeems for exactly 1 pUSD. Per market, `pair_shares` is the smaller of the two outcomes' bought shares, and `pair_cost` adds the two outcomes' average cost per share, fees included. `pair_edge` is `pair_shares × (1 − pair_cost)`.
- **Unmatched shares** are the extra shares of one outcome beyond the pairs, valued at that outcome's average cost.
- **Phase** compares each fill's block time with Gamma's `game_start_time`: before it is `pre_game`, from it on is `in_game`.
- A buy goes to the **underweight** outcome when, just before the fill, RN1 held fewer shares of it than of the other outcome, counting only this window's fills.

## The data

- Polygon blocks 91743315 to 97042228, from 2026-08-10 00:00 to 2026-11-10 00:00 UTC.
- Inputs and their last loads: `polygon.polymarket_ctf_exchange_v2` (fills) finished 2026-11-12T03:46:13Z; `polygon.polymarket_ctf` (conditions) finished 2026-11-12T03:46:52Z; `polymarket.markets` (Gamma market records) finished 2026-11-12T05:48:48Z. All read from the `polymarket_wallet_fills` and `polymarket_markets` marts.
- Checks: freshness, coverage and dead letters passed. dbt tests: 23 passed, 1 warned (see Caveats).
- `tests/reference/rn1_polymarket_fills_2026_11_08_matches_reference.sql` compares RN1's shares per token, side and role with the Polymarket Data API over blocks 96972629 to 96975028.
- Answered 2026-11-12T12:13:08Z at commit `c1cd556`, with uncommitted `addresses.json` changes that make both stream sources load only RN1's rows.
- Six analyses wrote the CSVs in `results/`. `derived.sql` (run `duckdb < derived.sql` in this folder) derives the bands, quantiles and splits below from those CSVs.

## 1. Complementary accumulation

**Observed.** RN1 bought both outcomes in 42,273 of 87,642 two-outcome markets (48.23%). Their 136,290,998.022061 pairs cost 134,216,176.095916 pUSD, an average of 0.984777 per pair after fees. 54.11% of pairs cost less than 1 (24,324 markets), and the pairs lock in 2,074,821.926145 pUSD.

The average hides a wide spread. A pair's cost depends on where the price stood when each side filled, and in-game prices swing far:

| Pair cost | Markets | Pairs | Share of pairs | Pair edge (pUSD) |
|---|--:|--:|--:|--:|
| below 0.90 | 11609 | 31093676.595234 | 22.81% | 6526880.045258 |
| 0.90 to 0.95 | 4612 | 17462761.369334 | 12.81% | 1289562.014765 |
| 0.95 to 0.98 | 4023 | 13403935.048162 | 9.83% | 457132.476827 |
| 0.98 to 1.00 | 4080 | 11790034.159001 | 8.65% | 117124.147484 |
| 1.00 to 1.02 | 2996 | 10004078.694471 | 7.34% | -89745.251149 |
| 1.02 to 1.05 | 3250 | 13768211.498495 | 10.1% | -462461.235479 |
| 1.05 and above | 11703 | 38768300.657364 | 28.45% | -5763671.066389 |

Over markets (each counted once), the pair cost runs from 0.748461 at the 10th percentile through 0.984127 at the median to 1.181102 at the 90th.

The sport matters. Tennis, RN1's largest spend, paid more than 1 per pair: ATP 1.01605 (−456,954.046211 pUSD) and WTA 1.010792 (−239,317.503331 pUSD). European football paid under 1: Premier League 0.95842, La Liga 0.96266, Serie A 0.958999, Champions League 0.948865, Bundesliga 0.900694. The full split by series and by market type is in sections 4 and 5 of `derived.sql`'s output.

## 2. Where the profit comes from

| Part | Amount (pUSD) | Status |
|---|--:|---|
| Pair edge | 2,074,821.926145 | **Observed.** A pair pays 1 whatever the result, so this holds whether RN1 merges the pair or holds it to payout. |
| Unmatched shares, at cost | 88,890,743.764587 on 190,884,705.481531 shares | **Not answered.** Each share pays 1 or 0 at resolution; these results carry no payouts. |
| Taker fees paid | 640,440.33281 | **Observed.** 1.6306% of taker spend. Maker fills paid no fees. Already inside the costs above. |
| Maker rebates, liquidity rewards | none loaded | **Not answered.** No source loads them. |

The unmatched shares cost far more than the pair edge brings in. For their cost to come back, 46.57% of them must land on the winning outcome. Each percentage point above or below that is worth 1,908,847.054815 pUSD, close to the whole pair edge. So the pairs below 1 do not show that the strategy pays; the directional book decides it.

## 3. Maker behaviour

**Observed**, from `by_role` (sports markets):

| Role | Fills | Share of fills | Shares | pUSD | Median fill (shares) | Mean fill (shares) | Mean fill (pUSD) | Fills per minute |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| maker | 817677 | 89.67% | 381629227.268751 | 183194260.167419 | 55.555556 | 466.723691 | 224.04233 | 6.17 |
| taker | 93480 | 10.25% | 81837474.256902 | 39272295.252004 | 200.0 | 875.454367 | 420.114412 | 0.71 |

Fills per minute spread each role's fills evenly over the window's 92 days. As taker, RN1 trades less often and in bigger lots.

Both roles buy at similar prices, 0.480032 (maker) and 0.479882 (taker) pUSD per share on average. Most shares go at 0.30 to 0.70, but RN1 also buys longshots and near-certainties (`derived.sql` section 11, which bands each token's average price, not each fill's).

The maker share differs by market type: 89.52% on moneylines, 92.24% on totals, 81.9% on spreads, 97.6% on exact-score markets.

The more RN1 filled as maker in a market, the better its pairs:

| Maker share of the market's fills | Markets | pUSD spent | Bought both | Avg pair cost | Pair edge (pUSD) |
|---|--:|--:|--:|--:|--:|
| all maker | 61399 | 72078566.651135 | 37.5% | 0.99044 | 325226.803437 |
| 90 to 99% | 5985 | 73163338.158802 | 98.01% | 0.974207 | 1399441.050492 |
| 50 to 89% | 13235 | 65652673.088753 | 83.73% | 0.989966 | 423924.257457 |
| 1 to 49% | 2197 | 8982162.390724 | 82.7% | 1.010753 | -55123.660093 |
| all taker | 4826 | 3230179.571089 | 9.97% | 1.029155 | -18647.319976 |

**Not answered:** prices against the best bid and ask at each fill. No order-book data is loaded, so neither the spread RN1 earned nor how far its quotes sat from the touch can be measured.

## 4. Inventory

**Observed.** Of the buys that changed the balance between the two outcomes, 42.87% went to the underweight outcome (352,815 fills) and the rest to the outcome RN1 already held more of (470,192 fills). Another 88,150 buys came when both sides were level. In-game the underweight share is 43.41%; before the game it is 20.64%.

**Inferred:** RN1 does not steer its buys toward the short side. It lets one side build. Two points weaken this reading. The count is of fills, not orders: when one resting order fills against several takers, every fill after the one that tips the balance counts as overweight, which pulls the figure down. Merges and splits add or remove equal amounts of both outcomes, so leaving them out does not change the gap between the two sides.

Where the unmatched shares sit, by RN1's own average costs:

| Unmatched shares | Markets | Shares | Cost (pUSD) | Avg price |
|---|--:|--:|--:|--:|
| both sides bought, extra on the dearer side | 20373 | 70636139.728289 | 46733067.477346 | 0.661603 |
| both sides bought, extra on the cheaper side | 21775 | 79042094.271724 | 24443750.115585 | 0.30925 |
| one side only | 45369 | 41206471.481518 | 17713926.502634 | 0.429882 |

By count of markets RN1 leans neither way. By money, more of its open risk sits on the dearer side, the outcome the market thought likelier when RN1 bought.

## 5. Event timing

**Observed**, from `by_phase`:

| Phase | Fills | Maker share | Shares | pUSD | Avg price | Markets | Underweight buys |
|---|--:|--:|--:|--:|--:|--:|--:|
| pre_game | 26336 | 83.39% | 29324935.024100 | 14156867.356175 | 0.482759 | 6736 | 20.64% |
| in_game | 884821 | 89.93% | 434141766.501553 | 208309688.063248 | 0.479820 | 85554 | 43.41% |
| all | 911157 | 89.74% | 463466701.525653 | 222466555.419423 | 0.480005 | 87642 | 42.87% |

Every market had a Gamma game start time. RN1's first fill came after the start in 92.31% of markets. Its first fill came a median 26 minutes after the start (90th percentile 100 minutes), and its last fill a median 84 minutes after (90th percentile 146).

**Not answered:** behaviour near resolution. These analyses carry no resolution time, so the last minutes of a game cannot be told apart from the rest of `in_game`.

## 6. Profitability

**Not answered.** Realized and unrealized P&L, P&L per market, drawdown and return on capital all need each market's payout and RN1's merges and redemptions. The analyses read only fills. What the fills do bound:

- spend: 222,503,015.363408 pUSD before fees, 640,440.33281 pUSD in fees;
- pair edge: 2,074,821.926145 pUSD, certain at resolution;
- unmatched cost: 88,890,743.764587 pUSD, which breaks even if 46.57% of the unmatched shares win.

Spend is concentrated: the median market took 256.645402 pUSD over 3 fills, while the top 1% of markets took 24.74% of all spend and the top 10% took 73.42%. By month of first fill, September had the most spend (85,234,340.295456 pUSD) and October the most pair edge (996,237.756588 pUSD) at the cheapest pairs (0.975876).

The `polymarket_market_participants` mart already holds `pnl_usdc` per wallet and market, cash after fees plus what the open shares are worth. An analysis on it for RN1 would answer this question.

## 7. What kind of strategy this is

**Inferred** from the observed figures above:

- **Two-sided in-game quoting, done with buys alone.** On Polymarket a bid for one outcome at p is an offer of the other at 1 − p, so buying both outcomes is how RN1 quotes both sides of a market. It never sells; it exits by merging pairs for 1 pUSD or by holding to payout. 89.75% of fills are maker, 884,821 of 911,157 come in-game, and the markets where RN1 was 90 to 99% maker hold 1,399,441.050492 of the 2,074,821.926145 pUSD pair edge.
- **Complementary accumulation is the mechanism, not a lock.** Pairs average 0.984777, about 1.5 cents below par, but 45.89% of pairs cost 1 or more and 28.45% cost 1.05 or more. That is the pattern of resting bids filled as prices swing: when one outcome's price falls, the bids on it fill. This fits adverse selection, but without order-book data it stays a reading, not a measurement.
- **A large directional book.** 45,369 markets saw buys of one outcome only, and unmatched shares cost 42.84 times the pair edge. Whatever RN1 earns or loses mostly comes from here.
- **Taker bursts in the biggest tennis markets.** RN1's largest market, Barranquilla: Julieta Pareja vs Lucrezia Stefanini, took 1,030,554.844846 pUSD over 67 fills, 66 of them as taker, at a pair cost of 1.035913 (−31,814.048282 pUSD pair edge). The third largest, Lepchenko vs Melichar, was all taker at 1.036052. Paying above par for pairs by crossing the spread fits hedging or directional bets, not market making.
- **Grid quoting or probability-aware quoting:** these results cannot tell them apart. Both need the order book, or at least each order's price against the market's price at the time.

**Not answered:** the chronological rebuild of several heavy markets that issue #45 asks for. The analyses export per-market totals, not per-fill rows. The top 10 markets by spend are in section 10 of `derived.sql`'s output.

## Caveats

- **Fills only.** Splits, merges, redemptions and token transfers are not in these analyses, though `polygon.polymarket_ctf` loads the first three. Inventory starts from zero at the window's first block, so shares RN1 held before 10 August are missing.
- **Pairing by average cost.** Each outcome's pair cost uses the average over all its shares, unmatched ones included. Pairing first-in-first-out, or cheapest shares first, would give other pair costs and another pair edge.
- **703 fills have no market.** Their tokens are missing from Gamma (686 maker, 17 taker). They count in the headline and `by_role`, and nowhere else. This is why `by_phase` gives 89.74% maker and the headline 89.75%.
- **A dbt test warned.** `polymarket_resolved_markets_are_zero_sum` finds resolved markets whose wallets' P&L and fees do not net to zero, because two channels are not loaded by design: splits, merges and redemptions made by calling the old binary adapter directly, and outcome tokens sent from wallet to wallet. It touches P&L marts, not fills; it would matter to the P&L analysis suggested under question 6.
- **No cross-check** against Portal; the marts answered the question.

## Files

- `question.yaml`: the question, definitions and window.
- `answer.json`: the headline, SQL, loads and checks.
- `results/*.csv`: the six analyses. `by_token` has 156,161 rows and `by_market` 87,642.
- `derived.sql`: the bands, quantiles and splits quoted here, read from the CSVs.
