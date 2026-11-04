import json
import shutil

import pytest
import yaml

from pipeline.assets.ingestion import SOURCES, package_dir
from pipeline.cli import REPO_ROOT, BadInput
from pipeline.cli.new_source import package_name, read_sources, run

TEMPLATE = "ethereum-eth-balances"


@pytest.fixture
def repo(tmp_path):
    """The files new-source reads, copied from the real repository, with local-only files in the template."""
    template = tmp_path / "ingestion" / "sources" / TEMPLATE
    shutil.copytree(REPO_ROOT / "ingestion" / "sources" / TEMPLATE, template, ignore=shutil.ignore_patterns("node_modules", ".env"))
    (template / "node_modules" / "viem").mkdir(parents=True)
    (template / ".env").write_text("ERPC_URL=http://secret\n")
    shutil.copytree(REPO_ROOT / "transformation" / "models" / "staging", tmp_path / "transformation" / "models" / "staging")
    assets = tmp_path / "orchestration" / "pipeline" / "assets"
    assets.mkdir(parents=True)
    shutil.copy(REPO_ROOT / "orchestration" / "pipeline" / "assets" / "ingestion.py", assets)
    return tmp_path


def snapshot(root):
    return {path.relative_to(root): path.read_bytes() if path.is_file() else None for path in root.rglob("*")}


def sources_of(repo):
    return read_sources((repo / "orchestration/pipeline/assets/ingestion.py").read_text())[0]


def test_package_name_matches_the_dagster_asset_rule():
    for source, table in SOURCES:
        assert package_name(source, table) == package_dir(source, table).name


def test_adds_a_table_to_an_existing_source(repo, capsys):
    ingestion_before = (repo / "orchestration/pipeline/assets/ingestion.py").read_text()
    yml_before = (repo / "transformation/models/staging/ethereum/_ethereum__sources.yml").read_text()

    assert run(repo, "ethereum", "erc721_holdings", TEMPLATE) == 0

    package = repo / "ingestion/sources/ethereum-erc721-holdings"
    assert not (package / "node_modules").exists()
    assert not (package / ".env").exists()
    assert (package / ".env.example").is_file()
    assert (package / "addresses.json").is_file()
    assert json.loads((package / "package.json").read_text())["name"] == "@ingestion/ethereum-erc721-holdings"
    source_ts = (package / "src/source.ts").read_text()
    assert 'name: "ethereum"' in source_ts
    assert 'table: "erc721_holdings"' in source_ts
    assert 'table: "eth_balances"' not in source_ts

    yml_path = repo / "transformation/models/staging/ethereum/_ethereum__sources.yml"
    yml = yml_path.read_text()
    assert yml.startswith(yml_before)
    (ethereum,) = yaml.safe_load(yml)["sources"]
    tables_before = [t["name"] for t in yaml.safe_load(yml_before)["sources"][0]["tables"]]
    assert [t["name"] for t in ethereum["tables"]] == [*tables_before, "erc721_holdings"]
    assert ethereum["tables"][-1] == {
        "name": "erc721_holdings",
        "identifier": "ethereum_erc721_holdings",
        "columns": [{"name": "id", "data_tests": ["unique", "not_null"]}],
    }

    model = (repo / "transformation/models/staging/ethereum/stg_ethereum__erc721_holdings.sql").read_text()
    assert "{{ source('ethereum', 'erc721_holdings') }}" in model
    assert all(column in model for column in ("id,", "data,", "_loaded_at"))

    ingestion_after = (repo / "orchestration/pipeline/assets/ingestion.py").read_text()
    assert sources_of(repo) == [*SOURCES, ("ethereum", "erc721_holdings")]
    added = [line for line in ingestion_after.splitlines() if line not in ingestion_before.splitlines()]
    assert added == ['    ("ethereum", "erc721_holdings"),']
    assert len(ingestion_after.splitlines()) == len(ingestion_before.splitlines()) + 1

    out = capsys.readouterr().out
    assert "changed orchestration/pipeline/assets/ingestion.py" in out
    assert "changed transformation/models/staging/ethereum/_ethereum__sources.yml" in out
    assert "pnpm install" in out and "mart" in out


def test_creates_the_sources_file_of_a_new_source(repo):
    assert run(repo, "base", "eth_balances", TEMPLATE) == 0

    yml = (repo / "transformation/models/staging/base/_base__sources.yml").read_text()
    shape = (repo / "transformation/models/staging/ethereum/_ethereum__sources.yml").read_text()
    assert yml.splitlines()[:7] == shape.replace("ethereum", "base").splitlines()[:7]
    (base,) = yaml.safe_load(yml)["sources"]
    assert base["name"] == "base"
    assert base["schema"] == "{{ env_var('RAW_SCHEMA', 'raw') }}"
    assert base["tables"][0]["identifier"] == "base_eth_balances"
    assert (repo / "transformation/models/staging/base/stg_base__eth_balances.sql").is_file()
    source_ts = (repo / "ingestion/sources/base-eth-balances/src/source.ts").read_text()
    assert 'name: "base"' in source_ts and 'name: "ethereum"' not in source_ts
    assert sources_of(repo)[-1] == ("base", "eth_balances")


def refuses_without_writing(repo, *args, match):
    before = snapshot(repo)
    with pytest.raises(BadInput, match=match):
        run(repo, *args)
    assert snapshot(repo) == before


def test_refuses_a_template_missing_from_sources(repo):
    shutil.copytree(repo / "ingestion/sources" / TEMPLATE, repo / "ingestion/sources/scratch")
    refuses_without_writing(repo, "ethereum", "nft_balances", "scratch", match="no SOURCES entry")


def test_refuses_a_template_that_does_not_exist(repo):
    refuses_without_writing(repo, "ethereum", "nft_balances", "ethereum-nft-balances", match="no source package")


def test_refuses_a_package_that_exists(repo):
    (repo / "ingestion/sources/ethereum-nft-balances").mkdir()
    refuses_without_writing(repo, "ethereum", "nft_balances", TEMPLATE, match="already exists")


def test_refuses_a_pair_already_in_sources(repo):
    refuses_without_writing(repo, "ethereum", "erc20_balances", TEMPLATE, match="already in SOURCES")


def test_refuses_a_source_ts_it_cannot_rename_exactly_once(repo):
    source_ts = repo / "ingestion/sources" / TEMPLATE / "src/source.ts"
    source_ts.write_text(source_ts.read_text() + '\n// table: "eth_balances"\n')
    refuses_without_writing(repo, "ethereum", "nft_balances", TEMPLATE, match="exactly once")


def test_refuses_a_table_the_sources_file_already_has(repo):
    yml = repo / "transformation/models/staging/ethereum/_ethereum__sources.yml"
    yml.write_text(yml.read_text() + "      - name: nft_balances\n        identifier: ethereum_nft_balances\n")
    refuses_without_writing(repo, "ethereum", "nft_balances", TEMPLATE, match="already has table")


def test_refuses_a_sources_file_where_the_table_would_land_under_another_source(repo):
    yml = repo / "transformation/models/staging/ethereum/_ethereum__sources.yml"
    yml.write_text(yml.read_text() + "  - name: legacy\n    tables:\n      - name: old\n")
    refuses_without_writing(repo, "ethereum", "nft_balances", TEMPLATE, match="could not add")

@pytest.mark.parametrize("source, table", [("Ethereum", "x"), ("ethereum", "nft-balances"), ("1chain", "x")])
def test_refuses_names_that_are_not_identifiers(repo, source, table):
    refuses_without_writing(repo, source, table, TEMPLATE, match="must match")
