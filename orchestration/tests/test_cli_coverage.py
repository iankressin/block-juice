import json
from dataclasses import replace
from pathlib import Path

import pytest

from pipeline.cli import BadInput, coverage, main
from pipeline.cli.coverage import Coverage, stream_sources
from pipeline.sources import SOURCES_FILE, read_sources

REPO_ROOT = Path(__file__).resolve().parents[2]
WALLET = "0x28C6c06298d514Db089934071355E5743bf21d60"
USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
UNI = "0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0"
ADDRESSES = json.dumps({"wallets": [WALLET], "tokens": [USDC]})
TRANSFERS = {"name": "ethereum", "table": "erc20_transfers", "package": "evm-erc20-transfers", "settings": "chains/ethereum"}
BALANCES = {"name": "ethereum", "table": "eth_balances", "package": "evm-eth-balances", "settings": "chains/ethereum"}


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A repo with one stream source and one call source, each in a package that loads several chains."""
    monkeypatch.setenv("RAW_SCHEMA", "raw")
    monkeypatch.delenv("START_BLOCK", raising=False)
    (tmp_path / SOURCES_FILE).parent.mkdir(parents=True)
    for entry, env in ((TRANSFERS, "START_BLOCK=100\n"), (BALANCES, "BLOCK_NUMBER=latest\n")):
        folder = tmp_path / "ingestion" / "sources" / entry["package"] / entry.get("settings", "")
        folder.mkdir(parents=True)
        (folder / ".env.example").write_text(env)
        (folder / "addresses.json").write_text(ADDRESSES)
    (tmp_path / SOURCES_FILE).write_text(json.dumps([TRANSFERS, BALANCES]))
    return tmp_path


def test_a_stream_source_is_a_sources_entry_whose_env_example_sets_start_block(repo):
    assert stream_sources(repo) == ["ethereum.erc20_transfers"]


@pytest.mark.parametrize("entry", read_sources((REPO_ROOT / SOURCES_FILE).read_text()), ids=lambda e: f"{e.name}.{e.table}")
def test_the_rule_finds_exactly_the_packages_that_export_a_stream_source(entry):
    package = REPO_ROOT / "ingestion" / "sources" / entry.package
    exports_stream = "StreamSource<" in (package / "src" / "source.ts").read_text()
    assert (f"{entry.name}.{entry.table}" in stream_sources(REPO_ROOT)) == exports_stream


def test_the_repo_has_a_stream_source():
    assert "ethereum.erc20_transfers" in stream_sources(REPO_ROOT)


def test_start_block_comes_from_env_else_env_example(repo, monkeypatch):
    monkeypatch.setattr(coverage, "read_cursor", lambda source_table: None)
    folder = repo / "ingestion" / "sources" / "evm-erc20-transfers/chains/ethereum"

    def start():
        read = coverage.read(repo, "ethereum.erc20_transfers")
        return read.start_block, read.start_block_file

    assert start() == (100, "ingestion/sources/evm-erc20-transfers/chains/ethereum/.env.example")
    (folder / ".env").write_text("LOG_LEVEL=debug\n")
    assert start() == (100, "ingestion/sources/evm-erc20-transfers/chains/ethereum/.env.example")
    (folder / ".env").write_text("START_BLOCK=250\n")
    assert start() == (250, "ingestion/sources/evm-erc20-transfers/chains/ethereum/.env")


def test_process_start_block_wins_over_both_files_and_changes_coverage(repo, monkeypatch):
    monkeypatch.setattr(coverage, "read_cursor", lambda source_table: 300)
    folder = coverage.folders(repo)["ethereum.erc20_transfers"]
    (folder / ".env").write_text("START_BLOCK=150\n")
    monkeypatch.setenv("START_BLOCK", "200")

    read = coverage.read(repo, "ethereum.erc20_transfers")
    assert (read.start_block, read.start_block_file) == (200, "environment")
    assert read.gaps((100, 150), {}) == ["START_BLOCK 200 is after 100"]
    assert read.to_json()["covered"] == [200, 300]


@pytest.mark.parametrize("value", ["", "latest", "-1", "1.5", "1_0", "9007199254740992"])
def test_invalid_process_start_does_not_fall_back_to_a_valid_file(repo, monkeypatch, value):
    monkeypatch.setenv("START_BLOCK", value)
    folder = coverage.folders(repo)["ethereum.erc20_transfers"]
    with pytest.raises(BadInput, match="START_BLOCK in environment must be"):
        coverage.start_block(repo, folder)


def test_empty_chain_start_does_not_fall_back_to_an_earlier_example(repo):
    folder = coverage.folders(repo)["ethereum.erc20_transfers"]
    (folder / ".env").write_text("START_BLOCK=\n")
    with pytest.raises(BadInput, match="START_BLOCK in .*\\.env must be"):
        coverage.start_block(repo, folder)


def test_chain_start_falls_back_to_package_env_after_chain_files(repo):
    folder = coverage.folders(repo)["ethereum.erc20_transfers"]
    (folder / ".env.example").write_text("LOG_LEVEL=debug\n")
    (folder.parents[1] / ".env").write_text("START_BLOCK=250\n")
    assert coverage.start_block(repo, folder) == (
        250, "ingestion/sources/evm-erc20-transfers/.env"
    )


def test_zero_is_a_valid_process_start_block(repo, monkeypatch):
    monkeypatch.setenv("START_BLOCK", "0")
    folder = coverage.folders(repo)["ethereum.erc20_transfers"]
    assert coverage.start_block(repo, folder) == (0, "environment")


@pytest.mark.parametrize("value, expected", [
    ("+100", 100), ("1e2", 100), ("100.0", 100), ("0x64", 100),
    ("0b1100100", 100), ("0o144", 100), (" 100 ", 100), ("   ", 0),
])
def test_start_accepts_the_numeric_forms_ingestion_coerces(repo, monkeypatch, value, expected):
    monkeypatch.setenv("START_BLOCK", value)
    folder = coverage.folders(repo)["ethereum.erc20_transfers"]
    assert coverage.start_block(repo, folder) == (expected, "environment")


def test_each_chain_of_an_evm_package_reads_its_own_folder(repo, monkeypatch):
    monkeypatch.setattr(coverage, "read_cursor", lambda source_table: None)
    arbitrum = {**TRANSFERS, "name": "arbitrum", "settings": "chains/arbitrum"}
    (repo / SOURCES_FILE).write_text(json.dumps([arbitrum, TRANSFERS]))
    folder = repo / "ingestion" / "sources" / "evm-erc20-transfers" / "chains" / "arbitrum"
    folder.mkdir(parents=True)
    (folder / ".env.example").write_text("START_BLOCK=500\n")
    (folder / "addresses.json").write_text(json.dumps({"tokens": [UNI]}))

    read = coverage.read(repo, "arbitrum.erc20_transfers")
    assert (read.raw_table, read.start_block, read.start_block_file, read.filter) == (
        "raw.arbitrum_erc20_transfers",
        500,
        "ingestion/sources/evm-erc20-transfers/chains/arbitrum/.env.example",
        {"tokens": [UNI]},
    )
    assert coverage.read(repo, "ethereum.erc20_transfers").start_block == 100
    assert stream_sources(repo) == ["arbitrum.erc20_transfers", "ethereum.erc20_transfers"]


def test_a_key_with_one_address_reads_as_a_list_of_one(repo, monkeypatch):
    monkeypatch.setattr(coverage, "read_cursor", lambda source_table: None)
    folder = repo / "ingestion" / "sources" / "evm-erc20-transfers" / "chains" / "ethereum"
    (folder / "addresses.json").write_text(json.dumps({"token": USDC, "wallets": [WALLET]}))

    read = coverage.read(repo, "ethereum.erc20_transfers")
    assert read.filter == {"token": [USDC], "wallets": [WALLET]}
    assert read.gaps((100, 100), {"token": [USDC.lower()]}) == ["no run has saved a cursor"]


def test_a_key_that_holds_neither_an_address_nor_a_list_of_them_is_bad_input(repo, monkeypatch):
    monkeypatch.setattr(coverage, "read_cursor", lambda source_table: None)
    folder = repo / "ingestion" / "sources" / "evm-erc20-transfers" / "chains" / "ethereum"
    (folder / "addresses.json").write_text(json.dumps({"tokens": {"usdc": USDC}}))
    with pytest.raises(BadInput, match="must map each key to an address or a list of addresses"):
        coverage.read(repo, "ethereum.erc20_transfers")


@pytest.mark.parametrize("wallets", [[], None, WALLET, [42], {"owner": WALLET}])
def test_invalid_optional_wallet_filter_is_not_treated_as_all_wallets(repo, monkeypatch, wallets):
    monkeypatch.setattr(coverage, "read_cursor", lambda source_table: 180)
    folder = coverage.folders(repo)["ethereum.erc20_transfers"]
    (folder / "addresses.json").write_text(json.dumps({"tokens": [USDC], "wallets": wallets}))
    with pytest.raises(BadInput, match="wallets must be a nonempty list"):
        coverage.read(repo, "ethereum.erc20_transfers")


def test_a_start_block_that_is_not_a_number_is_bad_input(repo, monkeypatch):
    monkeypatch.setattr(coverage, "read_cursor", lambda source_table: None)
    (repo / "ingestion" / "sources" / "evm-erc20-transfers/chains/ethereum" / ".env").write_text("START_BLOCK=latest\n")
    with pytest.raises(BadInput, match="START_BLOCK in ingestion/sources/evm-erc20-transfers/chains/ethereum/.env must be"):
        coverage.read(repo, "ethereum.erc20_transfers")


def coverage_json(repo, monkeypatch, capsys, cursor, *args):
    for name in ("WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD", "WAREHOUSE_DB"):
        monkeypatch.setenv(name, "x")
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", repo)
    monkeypatch.setattr(coverage, "read_cursor", lambda source_table: {"ethereum_erc20_transfers": cursor}[source_table])
    assert main(["coverage", *args]) == 0
    return json.loads(capsys.readouterr().out)


def test_prints_each_stream_source_with_its_blocks_and_filter(repo, monkeypatch, capsys):
    assert coverage_json(repo, monkeypatch, capsys, 180) == [
        {
            "source": "ethereum.erc20_transfers",
            "raw_table": "raw.ethereum_erc20_transfers",
            "start_block": 100,
            "start_block_file": "ingestion/sources/evm-erc20-transfers/chains/ethereum/.env.example",
            "cursor": 180,
            "filter": {"wallets": [WALLET], "tokens": [USDC]},
            "covered": [100, 180],
        }
    ]


def test_covered_is_null_before_the_first_run(repo, monkeypatch, capsys):
    printed = coverage_json(repo, monkeypatch, capsys, None, "ethereum.erc20_transfers")
    assert (printed["cursor"], printed["covered"]) == (None, None)


def test_a_source_that_is_not_a_stream_source_exits_2(repo, monkeypatch, capsys):
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", repo)
    assert main(["coverage", "ethereum.eth_balances"]) == 2
    assert "'ethereum.eth_balances' is not a stream source; stream sources: ethereum.erc20_transfers" in capsys.readouterr().err


def loaded(start=100, cursor=180):
    return Coverage("ethereum", "erc20_transfers", "raw.ethereum_erc20_transfers", start, ".env", cursor,
                    {"wallets": [WALLET], "tokens": [USDC]})


def test_no_gaps_when_the_blocks_and_filter_are_inside_what_was_loaded():
    assert loaded().gaps((100, 180), {"wallets": [WALLET.lower()], "tokens": [USDC.upper().replace("0X", "0x")]}) == []
    assert loaded().gaps((120, 150), {}) == []


def test_gaps_name_each_block_and_address_that_was_not_loaded():
    assert loaded().gaps((99, 181), {"tokens": [USDC, "0xdead"], "pools": ["0xbeef"]}) == [
        "START_BLOCK 100 is after 99",
        "cursor 180 is before 181",
        "tokens not in addresses.json: 0xdead",
        "addresses.json has no 'pools'",
    ]
    assert loaded(cursor=None).gaps((100, 100), {}) == ["no run has saved a cursor"]


@pytest.mark.parametrize("source, table", [
    ("ethereum", "erc20_transfers"),
    ("arbitrum", "erc20_transfers"),
    ("base", "erc20_transfers"),
    ("polygon", "polymarket_ctf"),
    ("polygon", "polymarket_ctf_exchange_v2"),
])
def test_known_all_wallet_sources_cover_a_requested_wallet(source, table):
    read = replace(loaded(), source=source, table=table, filter={"tokens": [USDC]})
    assert read.gaps((100, 180), {"wallets": [WALLET]}) == []
    assert read.gaps((100, 180), {"tokens": ["missing-token"]}) == [
        "tokens not in addresses.json: missing-token"
    ]


@pytest.mark.parametrize("source, table", [
    ("ethereum", "wallet_transactions"),
    ("ethereum", "cow_ethflow"),
    ("unknown", "erc20_transfers"),
    ("polygon", "unknown"),
])
def test_missing_wallets_are_not_a_wildcard_for_other_sources(source, table):
    read = replace(loaded(), source=source, table=table, filter={"tokens": [USDC]})
    assert read.gaps((100, 180), {"wallets": [WALLET]}) == [
        "addresses.json has no 'wallets'"
    ]


def test_explicit_empty_wallets_do_not_cover_a_requested_wallet():
    read = replace(loaded(), filter={"wallets": [], "tokens": [USDC]})
    assert read.gaps((100, 180), {"wallets": [WALLET]}) == [
        f"wallets not in addresses.json: {WALLET}"
    ]
