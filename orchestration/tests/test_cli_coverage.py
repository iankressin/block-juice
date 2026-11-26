import csv
import hashlib
import json
from dataclasses import replace
from pathlib import Path

import psycopg2
import pytest

from pipeline.cli import BadInput, coverage, main
from pipeline.cli.coverage import Coverage, ScopeCoverage, stream_sources
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
    monkeypatch.setattr(coverage, "read_coverage", lambda source_table: [])
    monkeypatch.setattr(coverage, "read_configuration_cursor", lambda source_table, config: (False, None))
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
    assert "no verified ingestion contract" in read.gaps((100, 150), {})[0]
    assert read.to_json()["covered"] is None


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
    assert "no verified ingestion contract" in read.gaps((100, 100), {"token": [USDC.lower()]})[0]


def test_a_key_that_holds_neither_an_address_nor_a_list_of_them_is_bad_input(repo, monkeypatch):
    monkeypatch.setattr(coverage, "read_cursor", lambda source_table: None)
    folder = repo / "ingestion" / "sources" / "evm-erc20-transfers" / "chains" / "ethereum"
    (folder / "addresses.json").write_text(json.dumps({"tokens": {"usdc": USDC}}))
    with pytest.raises(BadInput, match="must map each key to an address or a list of addresses"):
        coverage.read(repo, "ethereum.erc20_transfers")


@pytest.mark.parametrize("wallets", [[], None, WALLET, [42], {"owner": WALLET}])
def test_invalid_optional_wallet_filter_is_not_treated_as_all_wallets(repo, monkeypatch, wallets):
    entry = {**TRANSFERS, "coverage": {"filters": ["wallets", "tokens"], "unrestricted": ["wallets"]}}
    (repo / SOURCES_FILE).write_text(json.dumps([entry]))
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


def test_a_bad_start_block_names_its_key_and_file_but_not_its_value(repo, monkeypatch):
    folder = coverage.folders(repo)["ethereum.erc20_transfers"]
    (folder / ".env").write_text("START_BLOCK=marker-value\n")
    with pytest.raises(BadInput) as raised:
        coverage.start_block(repo, folder)
    message = str(raised.value)
    assert message.startswith("START_BLOCK in ingestion/sources/evm-erc20-transfers/chains/ethereum/.env must be")
    assert "marker" not in message


# A connection error names the host, port, user and database it tried.
CONNECTION_ERROR = psycopg2.OperationalError(
    'connection to server at "marker-host" (10.0.0.1), port 5432 failed: '
    'FATAL:  password authentication failed for user "marker-user"'
)


def refuse(*args):
    raise CONNECTION_ERROR


@pytest.mark.parametrize("reader, place", [
    ("read_cursor", "the cursor in raw._sync"),
    ("read_coverage", "ingestion provenance in raw"),
    ("read_configuration_cursor", "the configuration cursor in raw"),
])
def test_a_failed_warehouse_read_names_the_error_type_but_not_the_driver_message(repo, monkeypatch, reader, place):
    monkeypatch.setattr(coverage, "read_cursor", lambda source_table: None)
    monkeypatch.setattr(coverage, reader, refuse)
    with pytest.raises(BadInput) as raised:
        coverage.read(repo, "ethereum.erc20_transfers")
    message = str(raised.value)
    assert message.startswith(f"could not read {place} (OperationalError)")
    assert "marker" not in message


def coverage_json(repo, monkeypatch, capsys, cursor, *args):
    for name in ("WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD", "WAREHOUSE_DB"):
        monkeypatch.setenv(name, "x")
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", repo)
    monkeypatch.setattr(coverage, "read_cursor", lambda source_table: {"ethereum_erc20_transfers": cursor}[source_table])
    assert main(["coverage", *args]) == 0
    return json.loads(capsys.readouterr().out)


PRINTED_WITHOUT_SCOPES = [
    {
        "source": "ethereum.erc20_transfers",
        "raw_table": "raw.ethereum_erc20_transfers",
        "start_block": 100,
        "start_block_file": "ingestion/sources/evm-erc20-transfers/chains/ethereum/.env.example",
        "cursor": 180,
        "filter": {"wallets": [WALLET], "tokens": [USDC]},
        "covered": None,
        "provenance": "unverified",
        "verified_ranges": [],
        "generations": [],
    }
]


def test_prints_each_stream_source_with_its_blocks_and_filter(repo, monkeypatch, capsys):
    assert coverage_json(repo, monkeypatch, capsys, 180) == PRINTED_WITHOUT_SCOPES


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


def test_a_source_whose_contract_leaves_wallets_optional_covers_a_requested_wallet():
    read = replace(loaded(), filter={"tokens": [USDC]}, unrestricted=frozenset({"wallets"}))
    assert read.gaps((100, 180), {"wallets": [WALLET]}) == []
    assert read.gaps((100, 180), {"tokens": ["missing-token"]}) == ["tokens not in addresses.json: missing-token"]
    assert read.gaps((100, 180), {}, all_wallets=True) == []


def test_missing_wallets_are_not_a_wildcard_without_the_contract():
    read = replace(loaded(), filter={"tokens": [USDC]})
    assert read.gaps((100, 180), {"wallets": [WALLET]}) == ["addresses.json has no 'wallets'"]
    assert read.gaps((100, 180), {}, all_wallets=True) == [
        "unrestricted wallet coverage is unknown for ethereum.erc20_transfers"
    ]


def test_explicit_empty_wallets_do_not_cover_a_requested_wallet():
    read = replace(loaded(), filter={"wallets": [], "tokens": [USDC]})
    assert read.gaps((100, 180), {"wallets": [WALLET]}) == [
        f"wallets not in addresses.json: {WALLET}"
    ]


@pytest.mark.parametrize("slug", ["token-transfer-graph", "token-net-accumulators", "token-categories", "token-flow-map"])
def test_token_answers_require_transfers_for_all_wallets(slug):
    from pipeline.cli.answer import coverage_check
    from pipeline.cli.question import load_question

    question = load_question(REPO_ROOT, slug)
    transfers = [source for source in question.sources if source.source.endswith(".erc20_transfers")]
    assert {source.chain for source in transfers} == set(question.blocks)
    for source in transfers:
        start, end = question.blocks[source.chain]
        loaded = Coverage(source.chain, "erc20_transfers", "", start, ".env", end, {"tokens": source.filter["tokens"]},
                          unrestricted=frozenset({"wallets"}))
        assert coverage_check([source], {source.source: loaded}, question.blocks).passed
        restricted = replace(loaded, filter={**loaded.filter, "wallets": [WALLET]})
        check = coverage_check([source], {source.source: restricted}, question.blocks)
        assert not check.passed
        assert "wallet" in check.detail


def test_rn1_answer_requires_all_reference_exchanges():
    from pipeline.cli.question import load_question

    question = load_question(REPO_ROOT, "rn1-polymarket-fills-2026-11-08")
    fills = next(source for source in question.sources if source.source.endswith(".polymarket_ctf_exchange_v2"))
    with (REPO_ROOT / "transformation/seeds/polymarket_contracts.csv").open() as contracts:
        exchanges = [row["address"] for row in csv.DictReader(contracts) if row["version"] == "ctf_exchange_v2"]
    assert len(exchanges) == 3
    start, end = question.blocks["polygon"]
    loaded = Coverage("polygon", "polymarket_ctf_exchange_v2", "", start, ".env", end, {"exchanges": exchanges},
                       unrestricted=frozenset({"wallets"}))
    assert not loaded.gaps((start, end), fills.filter)
    for exchange in exchanges:
        partial = replace(loaded, filter={"exchanges": [address for address in exchanges if address != exchange]})
        assert any(exchange in gap for gap in partial.gaps((start, end), fills.filter))


def evidence(first, last, filters=None, verified=True):
    return {"first": first, "last": last, "verified": verified, "config": {
        "version": 1, "source": "ethereum", "table": "erc20_transfers", "startBlock": first,
        "datasetHash": "dataset", "filter": filters or {"tokens": [USDC.lower()]},
        "unrestricted": ["wallets"], "settings": {},
    }}


def test_committed_contract_not_edited_files_establishes_coverage():
    read = replace(loaded(), evidence=(evidence(100, 180),), dataset_hash="dataset")
    assert read.gaps((100, 180), {"tokens": [USDC], "wallets": [WALLET]}) == []
    changed = replace(read, filter={"tokens": [UNI]})
    assert changed.covered is None
    assert changed.gaps((100, 180), {"tokens": [UNI]})
    restored = replace(changed, evidence=read.evidence + (evidence(100, 180, {"tokens": [UNI]}),))
    assert restored.gaps((100, 180), {"tokens": [UNI]}) == []


FILLS = {"name": "hypercore", "table": "fills", "package": "hypercore-fills", "coverage": {
    "filters": ["users", "coins"], "unrestricted": ["users", "coins"], "caseSensitive": ["coins"]}}


def fills_evidence(first, last, coins):
    item = evidence(first, last, {"users": [WALLET.lower()], "coins": coins})
    item["config"].update(source="hypercore", table="fills", unrestricted=["users", "coins"])
    return item


def test_case_sensitive_names_cover_only_their_exact_spelling_while_addresses_ignore_case():
    read = Coverage("hypercore", "fills", "raw.hypercore_fills", 100, ".env", 180,
                    {"users": [WALLET], "coins": ["ZEC"]}, (fills_evidence(100, 180, ["ZEC"]),), "dataset",
                    {}, frozenset({"users", "coins"}), frozenset({"coins"}))
    assert read.covered == (100, 180)
    assert read.gaps((100, 180), {"users": [WALLET], "coins": ["ZEC"]}) == []
    assert read.gaps((100, 180), {"users": [WALLET], "coins": ["zec"]})
    assert read.gaps((100, 180), {"users": [WALLET.upper().replace("0X", "0x")], "coins": ["ZEC"]}) == []
    legacy = replace(read, evidence=None)
    assert legacy.gaps((100, 180), {"coins": ["ZEC"]}) == []
    assert legacy.gaps((100, 180), {"coins": ["zec"]}) == ["coins not in addresses.json: zec"]
    assert legacy.gaps((100, 180), {"users": [WALLET.lower()]}) == []


def test_read_expects_coin_names_in_the_case_ingestion_recorded(repo, monkeypatch):
    (repo / SOURCES_FILE).write_text(json.dumps([FILLS]))
    folder = repo / "ingestion" / "sources" / "hypercore-fills"
    folder.mkdir(parents=True)
    (folder / ".env.example").write_text("START_BLOCK=100\n")
    (folder / "addresses.json").write_text(json.dumps({"users": [WALLET], "coins": ["io:ANTH", "ZEC"]}))
    monkeypatch.setenv("PORTAL_URL", "portal")
    monkeypatch.setattr(coverage, "read_cursor", lambda table: 180)
    item = fills_evidence(100, 180, ["ZEC", "io:ANTH"])
    item["config"]["datasetHash"] = hashlib.sha256(b"portal").hexdigest()
    monkeypatch.setattr(coverage, "read_coverage", lambda table: [item])
    expected = []
    def current(source_table, config):
        expected.append(config)
        return True, 180
    monkeypatch.setattr(coverage, "read_configuration_cursor", current)
    result = coverage.read(repo, "hypercore.fills")
    assert expected[0]["filter"] == {"users": [WALLET.lower()], "coins": ["ZEC", "io:ANTH"]}
    assert result.covered == (100, 180)
    assert result.gaps((100, 180), {"coins": ["zec"]})
    assert coverage.read(repo, "hypercore.fills").unrestricted == frozenset({"users", "coins"})


def test_all_wallets_requires_unrestricted_evidence_throughout_the_window():
    restricted = evidence(100, 180, {"tokens": [USDC.lower()], "wallets": [WALLET.lower()]})
    unrestricted = evidence(100, 170)
    read = replace(loaded(), evidence=(restricted, unrestricted))
    assert read.gaps((100, 180), {"tokens": [USDC], "wallets": [WALLET]}) == []
    assert read.gaps((100, 170), {"tokens": [USDC]}, all_wallets=True) == []
    assert read.gaps((100, 180), {"tokens": [USDC]}, all_wallets=True)
    unrestricted["config"]["unrestricted"] = []
    assert read.gaps((100, 170), {"tokens": [USDC]}, all_wallets=True)


def test_legacy_cursor_never_certifies_its_current_config():
    read = replace(loaded(), evidence=())
    assert read.cursor == 180
    assert read.covered is None
    assert read.to_json()["provenance"] == "unverified"
    assert read.gaps((100, 180), {})


def test_separate_generations_can_close_gaps_but_cannot_invent_them():
    read = replace(loaded(), evidence=(evidence(100, 120), evidence(122, 180)))
    assert read.covered is None
    assert read.gaps((100, 180), {"tokens": [USDC]})
    read = replace(read, evidence=read.evidence + (evidence(121, 121),))
    assert read.covered == (100, 180)
    assert read.gaps((100, 180), {"tokens": [USDC]}) == []


def test_restricted_wallet_history_does_not_cover_removing_the_restriction():
    read = replace(loaded(), filter={"tokens": [USDC]}, evidence=(
        evidence(100, 180, {"tokens": [USDC.lower()], "wallets": [WALLET.lower()]}),))
    assert read.covered is None
    assert read.gaps((100, 180), {"tokens": [USDC]})
    assert read.gaps((100, 180), {"tokens": [USDC], "wallets": [WALLET]}) == []


NARROWED = {"tokens": [USDC.lower()], "wallets": [WALLET.lower()]}


def test_a_question_that_leaves_a_restricted_key_out_fails_and_names_it():
    # addresses.json on disk still lists the wallet. The question's own filter decides.
    read = replace(loaded(), evidence=(evidence(100, 180, NARROWED),), dataset_hash="dataset")
    assert read.gaps((100, 180), {"tokens": [USDC]}) == [
        "the recorded loads restrict wallets, which the input's filter does not name; "
        "add wallets to the input's filter in question.yaml"
    ]
    assert read.gaps((100, 180), {"tokens": [USDC], "wallets": [WALLET]}) == []


def test_a_later_edit_to_addresses_json_does_not_change_an_old_answers_verdict():
    old = replace(loaded(), evidence=(evidence(100, 180, NARROWED),), dataset_hash="dataset")
    # Another question adds a token to the file. The record that proved the old answer is unchanged.
    edited = replace(old, filter={"wallets": [WALLET], "tokens": [USDC, UNI]})
    for wanted in ({"wallets": [WALLET]}, {"wallets": [WALLET], "tokens": [USDC]}):
        assert edited.gaps((100, 180), wanted) == old.gaps((100, 180), wanted)
    assert edited.gaps((100, 180), {"wallets": [WALLET], "tokens": [USDC]}) == []


def test_all_wallets_is_never_told_to_name_wallets():
    read = replace(loaded(), evidence=(evidence(100, 180, NARROWED),), dataset_hash="dataset")
    gaps = read.gaps((100, 180), {"tokens": [USDC]}, all_wallets=True)
    assert gaps and "add wallets" not in gaps[0]
    assert read.unnamed_keys({"tokens": [USDC]}, all_wallets=True) == []


def test_a_key_the_source_no_longer_reads_is_not_asked_for():
    record = evidence(100, 180, {"tokens": [USDC.lower()], "pools": ["0x01"]})
    read = replace(loaded(), evidence=(record,), dataset_hash="dataset", supported_filters=frozenset({"tokens", "wallets"}))
    assert read.unnamed_keys({"tokens": [USDC]}) == []
    assert read.gaps((100, 180), {"tokens": [USDC]}) == []


def test_every_shipped_stream_input_names_each_key_its_source_restricts():
    from pipeline.cli.question import load_question

    entries = {f"{e.name}.{e.table}": e for e in read_sources((REPO_ROOT / SOURCES_FILE).read_text())}
    streams = set(stream_sources(REPO_ROOT))
    problems = []
    for path in sorted((REPO_ROOT / "answers").glob("*/question.yaml")):
        question = load_question(REPO_ROOT, path.parent.name)
        if question.window.get("scope") == "loaded":
            continue
        for item in question.sources:
            if item.source not in streams:
                continue
            entry = entries[item.source]
            contract = entry.coverage or {}
            supported = frozenset(contract["filters"]) if "filters" in contract else None
            loaded_keys = coverage.address_filter(REPO_ROOT, entry.folder(REPO_ROOT), supported=supported)
            left_out = sorted(set(loaded_keys) - set(item.filter) - ({"wallets"} if item.all_wallets else set()))
            if left_out:
                problems.append(f"{question.slug}: {item.source} leaves out {', '.join(left_out)}")
    assert problems == []


def test_changed_dataset_and_unverified_factory_cache_are_not_coverage():
    read = replace(loaded(), evidence=(evidence(100, 180),), dataset_hash="another-dataset")
    assert read.covered is None
    read = replace(read, dataset_hash="dataset", evidence=(evidence(100, 180, verified=False),))
    assert read.covered is None


def test_cursor_follows_the_effective_generation_not_the_legacy_source_id(repo, monkeypatch):
    monkeypatch.setattr(coverage, "read_cursor", lambda source_table: 999)
    expected = []
    def current(source_table, config):
        expected.append(config)
        return True, 125
    monkeypatch.setattr(coverage, "read_configuration_cursor", current)
    read = coverage.read(repo, "ethereum.erc20_transfers")
    assert read.cursor == 125
    assert expected[0]["filter"]["tokens"] == [USDC.lower()]
    monkeypatch.setattr(coverage, "read_configuration_cursor", lambda source_table, config: (True, None))
    assert coverage.read(repo, "ethereum.erc20_transfers").cursor is None


def test_earlier_pool_discovery_requires_a_generation_that_read_that_history():
    item = evidence(100, 180)
    item["config"].update(version=2, settings={"POOLS_START_BLOCK": 50})
    read = replace(loaded(), evidence=(item,), settings={"POOLS_START_BLOCK": 1})
    assert read.covered is None
    assert read.gaps((100, 180), {})


def test_pool_start_override_only_applies_to_factory_sources(repo, monkeypatch):
    monkeypatch.setenv("POOLS_START_BLOCK", "50")
    monkeypatch.setattr(coverage, "read_cursor", lambda table: None)
    assert coverage.read(repo, "ethereum.erc20_transfers").settings == {}


@pytest.mark.parametrize(("name", "dataset"), [
    ("arbitrum.token_bridge", "arbitrum-one"),
    ("polygon.polymarket_ctf", "polygon-mainnet"),
    ("polygon.polymarket_ctf_exchange_v2", "polygon-mainnet"),
])
def test_empty_portal_url_uses_the_source_default(name, dataset, monkeypatch):
    monkeypatch.setenv("RAW_SCHEMA", "raw")
    monkeypatch.setenv("PORTAL_URL", "")
    monkeypatch.setattr(coverage, "read_coverage", lambda table: [])
    monkeypatch.setattr(coverage, "read_cursor", lambda table: None)
    expected_hash = hashlib.sha256(f"https://portal.sqd.dev/datasets/{dataset}".encode()).hexdigest()
    monkeypatch.setattr(coverage, "read_configuration_cursor",
                        lambda table, config: (True, 500 if config["datasetHash"] == expected_hash else None))
    assert coverage.read(REPO_ROOT, name).cursor == 500


def test_legacy_extra_filter_cannot_certify_a_pool_the_source_never_queried(repo, monkeypatch):
    entry = {**TRANSFERS, "coverage": {"filters": ["wallets", "tokens"], "unrestricted": ["wallets"]}}
    (repo / SOURCES_FILE).write_text(json.dumps([entry]))
    folder = coverage.folders(repo)["ethereum.erc20_transfers"]
    (folder / "addresses.json").write_text(json.dumps({"tokens": [USDC], "pools": ["p"]}))
    monkeypatch.setattr(coverage, "read_cursor", lambda table: 180)
    monkeypatch.setenv("PORTAL_URL", "portal")
    item = evidence(100, 180, {"tokens": [USDC.lower()], "pools": ["p"]})
    item["config"]["datasetHash"] = hashlib.sha256(b"portal").hexdigest()
    monkeypatch.setattr(coverage, "read_coverage", lambda table: [item])
    result = coverage.read(repo, "ethereum.erc20_transfers")
    assert result.filter == {"tokens": [USDC]}
    assert result.gaps((100, 180), {"tokens": [USDC]}) == []
    assert result.gaps((100, 180), {"pools": ["p"]})


def test_mixed_dataset_history_cannot_certify_either_dataset():
    first, second = evidence(100, 120), evidence(100, 180)
    second["config"]["datasetHash"] = "another"
    read = replace(loaded(), evidence=(first, second), dataset_hash="dataset")
    assert read.gaps((100, 120), {})


def test_factory_history_from_a_shared_cache_requires_fresh_discovery():
    item = evidence(100, 180)
    item["config"]["settings"]["POOLS_START_BLOCK"] = 50
    read = replace(loaded(), evidence=(item,), settings={"POOLS_START_BLOCK": 50})
    assert read.gaps((100, 180), {"tokens": [USDC]})
    rebuilt = {**item, "config": {**item["config"], "version": 2}}
    assert replace(read, evidence=(item, rebuilt)).gaps((100, 180), {"tokens": [USDC]}) == []


def add_scope(repo, name, addresses, env=None):
    folder = repo / "ingestion/sources/evm-erc20-transfers/chains/ethereum/scopes" / name
    folder.mkdir(parents=True)
    (folder / "addresses.json").write_text(json.dumps(addresses))
    if env is not None:
        (folder / ".env.example").write_text(env)


def test_each_scope_is_read_as_a_configuration_of_its_own(repo, monkeypatch):
    add_scope(repo, "mexc-2026-11", {"tokens": [USDC], "wallets": [WALLET]}, "START_BLOCK=40\nEND_BLOCK=90\n")
    add_scope(repo, "uni-only", {"tokens": [UNI]})
    monkeypatch.setattr(coverage, "read_cursor", lambda source_table: 180)
    cursors = {(100, ("tokens", "wallets")): 180, (40, ("tokens", "wallets")): 90, (100, ("tokens",)): 60}
    monkeypatch.setattr(coverage, "read_configuration_cursor",
                        lambda source_table, config: (True, cursors[config["startBlock"], tuple(sorted(config["filter"]))]))
    read = coverage.read(repo, "ethereum.erc20_transfers")
    folder = "ingestion/sources/evm-erc20-transfers/chains/ethereum"
    assert read.cursor == 180
    assert read.scopes == (
        ScopeCoverage("mexc-2026-11", 40, f"{folder}/scopes/mexc-2026-11/.env.example", 90, {"tokens": [USDC], "wallets": [WALLET]}),
        ScopeCoverage("uni-only", 100, f"{folder}/.env.example", 60, {"tokens": [UNI]}),
    )
    assert [scope["name"] for scope in read.to_json()["scopes"]] == ["mexc-2026-11", "uni-only"]


def test_a_source_without_scopes_prints_what_it_printed_before(repo, monkeypatch, capsys):
    assert coverage_json(repo, monkeypatch, capsys, 180) == PRINTED_WITHOUT_SCOPES


def test_a_scopes_cursor_never_falls_back_to_the_standing_cursor(repo, monkeypatch):
    add_scope(repo, "mexc-2026-11", {"tokens": [USDC]}, "START_BLOCK=40\nEND_BLOCK=90\n")
    add_scope(repo, "uni-only", {"tokens": [UNI]})
    monkeypatch.setattr(coverage, "read_cursor", lambda source_table: 180)
    answers = {(100, ("tokens", "wallets")): (True, 180), (40, ("tokens",)): (False, None), (100, ("tokens",)): (True, None)}
    monkeypatch.setattr(coverage, "read_configuration_cursor",
                        lambda source_table, config: answers[config["startBlock"], tuple(sorted(config["filter"]))])
    read = coverage.read(repo, "ethereum.erc20_transfers")
    assert read.cursor == 180
    assert [(scope.name, scope.cursor) for scope in read.scopes] == [("mexc-2026-11", None), ("uni-only", None)]


def test_a_scopes_record_proves_an_answer_the_standing_file_never_could():
    standing = evidence(100, 180)
    scope = evidence(40, 90, {"tokens": [UNI.lower()], "wallets": [WALLET.lower()]})
    read = replace(loaded(), evidence=(standing, scope), dataset_hash="dataset")
    assert read.gaps((40, 90), {"tokens": [UNI], "wallets": [WALLET]}) == []
    assert read.gaps((40, 120), {"tokens": [UNI], "wallets": [WALLET]})
