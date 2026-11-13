import json
import subprocess
from pathlib import Path

import pytest

from pipeline.source_config import parse_source_env
from pipeline.cli.coverage import parse_start_block
from pipeline.cli import BadInput

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("text", [
    'START_BLOCK="100\\n" # comment\nOTHER=x\n',
    "export START_BLOCK='100\\n'\n", "START_BLOCK=`100`\n", "START_BLOCK: 100\n",
    'START_BLOCK="100\\t"\n', 'START_BLOCK="100\\\\n"\n', "START_BLOCK='100\\\'0'\n",
    'START_BLOCK="100\\\"0"\n', "START_BLOCK=100#comment\n", "START_BLOCK=100  # comment\n",
    "START_BLOCK=1\nSTART_BLOCK=2\n", 'START_BLOCK="100\n"\n', "START_BLOCK=${OTHER}\n",
    "\ufeffSTART_BLOCK=\u00a0100\u00a0\n", "START_BLOCK=\u0085100\u0085\n",
    "START_BLOCK=100\u2028OTHER=2\n", "export\u2000START_BLOCK=100\n",
    "START_BLOCK=\nNEXT=value\n", "START_BLOCK\nNEXT=value\n", "éKEY=3\nSTART_BLOCK=100\n",
    "PASSWORD='\n", 'PASSWORD="\n', 'PASSWORD=`\n',
])
def test_source_files_match_the_installed_node_dotenv_parser(text):
    script = "const fs=require('node:fs');const dotenv=require(process.argv[1]);" \
             "process.stdout.write(JSON.stringify(dotenv.parse(fs.readFileSync(0,'utf8'))));"
    node = subprocess.run(["node", "-e", script, str(ROOT / "ingestion/lib/node_modules/dotenv")],
                          input=text, capture_output=True, text=True, check=True)
    assert parse_source_env(text) == json.loads(node.stdout)


@pytest.mark.parametrize("value, valid", [("\ufeff100\u2029", True), ("\u0085100", False),
                                        ("\u001c100", False), ("\u2003100", True)])
def test_number_trimming_uses_ecmascript_whitespace(value, valid):
    if valid:
        assert parse_start_block(value, "fixture") == 100
    else:
        with pytest.raises(BadInput):
            parse_start_block(value, "fixture")


@pytest.mark.parametrize("expression, expected", [
    ('"100\\n"', 100), ('`100`', None), ('${VALUE}', 100),
    ('"100\\t"', 100), ('\ufeff100\ufeff', 100),
])
def test_actual_cli_and_its_node_child_keep_legacy_root_expansion(tmp_path, monkeypatch, capsys, expression, expected):
    from pipeline import cli
    from pipeline.cli import coverage
    root = tmp_path
    source = root / "ingestion/sources/evm-erc20-transfers/chains/ethereum"
    source.mkdir(parents=True)
    (root / "ingestion/sources.json").write_text(json.dumps([{
        "name": "ethereum", "table": "erc20_transfers", "package": "evm-erc20-transfers", "settings": "chains/ethereum"
    }]))
    (source / ".env.example").write_text("START_BLOCK=999\nPORTAL_URL=https://portal.example\n")
    (source / "addresses.json").write_text('{"tokens":["0xaa"]}')
    (root / ".env").write_text(f"VALUE=100\nSTART_BLOCK={expression}\n")
    script = f"""import {{loadEnv}} from {json.dumps((ROOT / 'ingestion/lib/src/env.ts').as_uri())};
import * as z from {json.dumps((ROOT / 'ingestion/lib/node_modules/zod/index.js').as_uri())};
try {{console.log(JSON.stringify(loadEnv(z.object({{START_BLOCK:z.coerce.number().int().nonnegative()}}))));}}
catch {{process.exitCode=2;}}"""
    monkeypatch.setattr(cli, "REPO_ROOT", root)
    for key in ("START_BLOCK", "VALUE", "PORTAL_URL"):
        monkeypatch.delenv(key, raising=False)
    for key in cli.REQUIRED_ENV:
        monkeypatch.setenv(key, "fixture")
    monkeypatch.setattr(coverage, "read_cursor", lambda name: None)
    monkeypatch.setattr(coverage, "read_coverage", lambda name: [])
    monkeypatch.setattr(coverage, "read_configuration_cursor", lambda name, config: (False, None))
    result = cli.main(["coverage", "ethereum.erc20_transfers"])
    node = subprocess.run(["node", "--import", str(ROOT / "ingestion/node_modules/tsx/dist/loader.mjs"),
                           "--input-type=module", "--eval", script],
                          cwd=source.parents[1], env={**__import__('os').environ, "CHAIN": "ethereum"},
                          text=True, capture_output=True)
    assert node.returncode == (0 if expected is not None else 2), node.stderr
    assert result == node.returncode
    if expected is not None:
        assert json.loads(capsys.readouterr().out)["start_block"] == json.loads(node.stdout)["START_BLOCK"] == expected
