"""ingestion/sources.json is the one list of sources. These tests fail when it falls behind the packages,
and when the dbt project does not read a source by the name and table its package exports."""

import json
import shutil
import subprocess

import pytest
import yaml

from pipeline.cli import REPO_ROOT, BadInput
from pipeline.sources import SOURCES_FILE, SourceEntry, read_sources

ENTRIES = read_sources((REPO_ROOT / SOURCES_FILE).read_text())
STAGING = REPO_ROOT / "transformation" / "models" / "staging"


def pair(entry) -> str:
    return f"{entry.name}.{entry.table}"


def test_sources_json_is_fresh(tmp_path):
    """The generator, run now, writes exactly the committed file."""
    if shutil.which("pnpm") is None:
        pytest.skip("pnpm is not installed, so the generator cannot run")
    fresh = tmp_path / "sources.json"
    result = subprocess.run(
        ["pnpm", "--silent", "generate-sources", str(fresh)], cwd=REPO_ROOT / "ingestion", capture_output=True, text=True
    )
    assert result.returncode == 0, f"pnpm generate-sources failed:\n{result.stdout}{result.stderr}"
    committed = (REPO_ROOT / SOURCES_FILE).read_text()
    if fresh.read_text() == committed:
        return
    generated = read_sources(fresh.read_text())
    drift = [f"missing {pair(e)} ({e.package})" for e in generated if e not in ENTRIES]
    drift += [f"stale {pair(e)} ({e.package})" for e in ENTRIES if e not in generated]
    pytest.fail(
        f"{SOURCES_FILE} is out of date; run `pnpm generate-sources` in ingestion/ and commit it: "
        + ("; ".join(drift) or "same entries, different text")
    )


def test_sources_json_lists_todays_sources():
    assert {pair(e) for e in ENTRIES} >= {"ethereum.uniswap_v2", "ethereum.uniswap_v3", "ethereum.uniswap_v4"}
    assert len(ENTRIES) >= 9


def test_sources_json_is_sorted_by_name_then_table():
    assert [(e.name, e.table) for e in ENTRIES] == sorted((e.name, e.table) for e in ENTRIES)


@pytest.mark.parametrize("entry", ENTRIES, ids=pair)
def test_sources_json_package_dirs_exist(entry):
    package = REPO_ROOT / "ingestion" / "sources" / entry.package
    assert (package / "src" / "source.ts").is_file(), (
        f"{pair(entry)} names package {entry.package!r}, which is not a source package under ingestion/sources/"
    )
    assert (entry.folder(REPO_ROOT) / ".env.example").is_file(), f"{pair(entry)} has no .env.example in its folder"


def dbt_source_tables() -> dict[tuple[str, str], str]:
    """Every (source, table) the staging sources ymls declare, with the file that declares it."""
    tables = {}
    for yml in sorted(STAGING.glob("*/_*__sources.yml")):
        for source in yaml.safe_load(yml.read_text())["sources"]:
            for table in source.get("tables") or []:
                tables[(source["name"], table["name"])] = str(yml.relative_to(REPO_ROOT))
    return tables


def test_every_source_has_its_dbt_source_and_staging_model():
    """The name contract: dbt reads each source by the name and table its package exports, and no dbt
    source table is left without a package. A failure names the pair that drifted."""
    tables = dbt_source_tables()
    problems = []
    for entry in ENTRIES:
        if (entry.name, entry.table) not in tables:
            problems.append(f"{pair(entry)}: no table {entry.table!r} under source {entry.name!r} in a _*__sources.yml in {(STAGING / entry.name).relative_to(REPO_ROOT)}/")
        model = STAGING / entry.name / f"stg_{entry.name}__{entry.table}.sql"
        if not model.is_file():
            problems.append(f"{pair(entry)}: no staging model {model.relative_to(REPO_ROOT)}")
    listed = {(e.name, e.table) for e in ENTRIES}
    for (name, table), yml in sorted(tables.items()):
        if (name, table) not in listed:
            problems.append(f"{name}.{table}: {yml} declares it, but no package in {SOURCES_FILE} exports it")
    assert not problems, "\n".join(problems)


@pytest.mark.parametrize(
    "text, match",
    [
        ("not json", "must be a list"),
        ('[{"name": "ethereum", "table": "x"}]', "must be a list"),
        ('[{"name": "ethereum", "table": 1, "package": "p"}]', "not a string"),
        ('[{"name": "a", "table": "t", "package": "p"}, {"name": "a", "table": "t", "package": "q"}]', "a.t more than once"),
        ('[{"name": "a", "table": "t", "package": "p", "settings": 1}]', "settings is not a string"),
    ],
)
def test_read_sources_rejects_a_malformed_file(text, match):
    with pytest.raises(BadInput, match=match):
        read_sources(text)


def entry_with_case_sensitive(keys) -> str:
    coverage = {"filters": ["users", "coins"], "unrestricted": ["users"], "caseSensitive": keys}
    return json.dumps([{"name": "a", "table": "t", "package": "p", "coverage": coverage}])


def test_read_sources_accepts_case_sensitive_filter_keys():
    assert read_sources(entry_with_case_sensitive(["coins"]))[0].coverage["caseSensitive"] == ["coins"]


@pytest.mark.parametrize("keys, match", [
    ("coins", "caseSensitive must be a list"),
    ([1], "caseSensitive must contain filter names"),
    (["tokens"], r"caseSensitive names \['tokens'\], which are not filters"),
    (["coins", "tokens"], r"caseSensitive names \['tokens'\], which are not filters"),
])
def test_read_sources_rejects_case_sensitive_keys_that_are_not_filter_names(keys, match):
    with pytest.raises(BadInput, match=f"invalid coverage contract for a.t: {match}"):
        read_sources(entry_with_case_sensitive(keys))


WALLETS = SourceEntry("ethereum", "wallet_transactions", "evm-wallet-transactions", "chains/ethereum")


def add_scope(root, name):
    folder = WALLETS.folder(root) / "scopes" / name
    folder.mkdir(parents=True)
    (folder / "addresses.json").write_text("{}")


def test_a_scope_is_a_folder_with_an_addresses_json(tmp_path):
    for name in ("mexc-2026-11", "binance-hack"):
        add_scope(tmp_path, name)
    (WALLETS.folder(tmp_path) / "scopes" / "notes").mkdir()
    (WALLETS.folder(tmp_path) / "scopes" / "README.md").write_text("")
    assert WALLETS.scopes(tmp_path) == ["binance-hack", "mexc-2026-11"]
    assert SourceEntry("ethereum", "eth_balances", "evm-eth-balances", "chains/ethereum").scopes(tmp_path) == []


def test_a_scope_name_that_is_not_a_slug_is_bad_input(tmp_path):
    add_scope(tmp_path, "MEXC 2026")
    with pytest.raises(BadInput, match="scope name 'MEXC 2026'"):
        WALLETS.scopes(tmp_path)


def test_a_scope_name_with_a_trailing_newline_is_bad_input(tmp_path):
    # Python's `$` also matches before a final newline, which the TS rule refuses.
    add_scope(tmp_path, "trial\n")
    with pytest.raises(BadInput, match=r"scope name 'trial\\n'"):
        WALLETS.scopes(tmp_path)


def test_the_bad_scope_name_error_names_the_folder_from_the_repo_root(tmp_path):
    add_scope(tmp_path, "MEXC 2026")
    with pytest.raises(BadInput) as error:
        WALLETS.scopes(tmp_path)
    assert str(tmp_path) not in str(error.value)
    assert str(WALLETS.folder(tmp_path).relative_to(tmp_path) / "scopes") in str(error.value)
