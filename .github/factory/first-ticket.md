# The first ticket: a known answer

File this through the Analysis form once the App and the secrets exist. The repo already answers it from `dex_trades`, so the dry run tests the factory, not the pipeline. A scope run that agrees with the mart and a build run that ships only a seed, a test and an analysis is a pass.

**Question**
How many Uniswap v3 swaps traded UNI on Ethereum on 2026-10-15, and what was their volume in UNI?

**Reasoning**
A dry run of the factory on a question the repo already answers. The scope comment should match what `analytics.dex_trades` holds for that day; the build run should find no source or mart to build and ship only the reference seed, its test and an analysis.

**Definitions**
A swap is one Swap event of a Uniswap v3 pool whose pair includes UNI, 0x1f9840a85d5af5bf1d1762f925bdaddc4201f984, on Ethereum. Volume is the sum of the absolute UNI amount of each swap, in UNI, not USD. Count every pool, including pools against stablecoins and WETH.

**Window**
2026-10-15 UTC, one day. Blocks from `bj blocks ethereum 2026-10-15T00:00:00Z 2026-10-16T00:00:00Z`.

**Deliverable**
An analysis over existing marts.

**Tolerance hint**
Exact for the count. Relative 0.1% for the volume, to absorb decimal rounding between the oracle and the mart.
