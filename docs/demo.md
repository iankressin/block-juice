# Run a deterministic local example

The demo builds the real balance models from six synthetic raw readings, runs the existing
`tracked-wallets-eth` question, validates **3.75 ETH**, and exports an XLSX report. It requires
Python/uv and Docker. It does not require Node, chain RPC credentials, Claude, or a populated warehouse.

From the checkout root:

```sh
uv run --project orchestration bj demo
```

Docker starts a temporary `postgres:16` container on a randomly assigned loopback port; the first
run may download that image. The demo copies the dbt project into a temporary directory, loads
fixture rows, builds and tests `latest_balances` plus the empty transfer mart needed by its
reconciliation checks, and runs the ordinary answer/report code. It
does not read or change your warehouse, source filters or `.env` files. The container and temporary
project are removed when the command finishes or fails.

The output path is printed at the end, under `.demo/` by default. Choose a new directory with
`bj demo --output /path/to/my-demo`; an existing path is rejected rather than overwritten.
It contains `question.yaml`, `answer.json`, `answer.md`, `results/` and `reports/`. The report
explicitly identifies the input as synthetic. There are no Google uploads.

The three ETH readings are 1 ETH at block 99 for wallet 1, then 1.25 ETH at block 100 for the same
wallet and 2.5 ETH at block 100 for wallet 2. Latest state therefore totals 3.75 ETH, not 4.75 ETH.
An ERC-20 reading and two other-chain readings exercise the existing union without contributing
to the ETH total. All model and answer checks must pass before the demo succeeds.

Use [analysis authoring](analysis-authoring.md) for your own question after the demo. The demo
proves the local raw-to-model-to-answer path; it is not a provider or production-scale benchmark.
