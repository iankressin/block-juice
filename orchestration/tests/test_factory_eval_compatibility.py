"""Default-branch factory steps must also work with a ticket branch's older bj command."""

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

import pytest
import yaml


REPO = Path(__file__).resolve().parents[2]
WORKFLOW = yaml.safe_load((REPO / ".github/workflows/factory-build.yml").read_text())
STEPS = WORKFLOW["jobs"]["work"]["steps"]

# The legacy CLI contract at 16e1e7e: answer --eval writes to the root answer directory;
# check has no --eval option and writes its verdict to that same answer.json. A separate
# executable ensures the workflow really probes and invokes the old parser/layout.
LEGACY_CLI = '''\
import argparse
import json
import os
from pathlib import Path

root = argparse.ArgumentParser()
commands = root.add_subparsers(dest="command", required=True)
answer = commands.add_parser("answer")
answer.add_argument("slug")
answer.add_argument("--eval", action="store_true")
check = commands.add_parser("check")
check.add_argument("slug")
check.add_argument("name")
check.add_argument("status", choices=("passed", "failed"))
check.add_argument("detail", nargs="+")
args = root.parse_args()
folder = Path(os.environ["TEST_ROOT"]) / "answers" / args.slug
folder.mkdir(parents=True, exist_ok=True)
path = folder / "answer.json"
if args.command == "answer":
    path.write_text(json.dumps({"eval": args.eval, "checks": []}))
    (folder / "results").mkdir(exist_ok=True)
else:
    data = json.loads(path.read_text())
    data["checks"].append({"name": args.name, "status": args.status, "detail": " ".join(args.detail)})
    path.write_text(json.dumps(data))
'''


def command_environment(tmp_path, legacy):
    executable = tmp_path / "bj.py"
    current = """\
import os
import sys
from pathlib import Path
from pipeline import cli
cli.REPO_ROOT = Path(os.environ["TEST_ROOT"])
sys.exit(cli.main(sys.argv[1:]))
"""
    executable.write_text(LEGACY_CLI if legacy else current)
    # Only replace uv's environment/bootstrap layer; run a real Python CLI parser and writer.
    uv = tmp_path / "uv"
    uv.write_text(
        "#!/bin/sh\nshift 4\nexec " + shlex.quote(sys.executable) + " "
        + shlex.quote(str(executable)) + ' "$@"\n'
    )
    uv.chmod(0o755)
    return {
        **os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}", "TEST_ROOT": str(tmp_path),
        "PYTHONPATH": str(REPO / "orchestration"), "SLUG": "sample", "NAME": "sample",
        "STATUS": "passed", "DETAIL": "matches oracle", "FACTORY": str(REPO / ".github/factory"),
        "ISSUE": "12", "BRANCH": "factory/12-sample", "PR": "",
        "GITHUB_OUTPUT": str(tmp_path / "output"),
    }


def run_script(script, env, tmp_path):
    return subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", script], env=env, cwd=tmp_path,
        capture_output=True, text=True, check=True,
    )


@pytest.mark.parametrize("legacy", [True, False], ids=["old-ticket-cli", "current-cli"])
def test_factory_detects_the_checked_out_cli_and_uses_its_eval_directory(tmp_path, legacy):
    env = command_environment(tmp_path, legacy)
    folder = tmp_path / "answers/sample"
    if legacy:
        run_script("uv run --project orchestration bj answer sample --eval", env, tmp_path)
        assert json.loads((folder / "answer.json").read_text())["eval"] is True
    else:
        folder.mkdir(parents=True)
        (folder / "answer.json").write_text('{"eval": false, "checks": []}')
        (folder / "eval").mkdir()
        (folder / "eval/answer.json").write_text('{"eval": true, "checks": []}')

    detect = next(step for step in STEPS if step.get("id") == "answer_layout")
    run_script(detect["run"], env, tmp_path)
    layout = dict(line.split("=", 1) for line in Path(env["GITHUB_OUTPUT"]).read_text().splitlines())
    expected = "answers/sample" if legacy else "answers/sample/eval"
    assert layout == {"answer_dir": expected, "check_eval": "false" if legacy else "true"}

    env.update(ANSWER_DIR=layout["answer_dir"], CHECK_EVAL=layout["check_eval"])
    Path(env["GITHUB_OUTPUT"]).write_text("")
    prompt = next(step for step in STEPS if step.get("id") == "prompt")
    run_script(prompt["run"], env, tmp_path)
    rendered = Path(env["GITHUB_OUTPUT"]).read_text()
    assert f"Evaluation answer directory: `{expected}`" in rendered
    assert "<eval-dir>/answer.md" in rendered
    assert "answers/<slug>/eval/answer.md" not in rendered

    verdict = next(step for step in STEPS if step.get("name", "").startswith("Record the verdict"))
    run_script(verdict["run"], env, tmp_path)
    data = json.loads((tmp_path / expected / "answer.json").read_text())
    assert data["checks"] == [{"name": "reference_match", "status": "passed", "detail": "matches oracle; see PR"}]
    if legacy:
        assert not (folder / "eval").exists()
    else:
        assert json.loads((folder / "answer.json").read_text()) == {"eval": False, "checks": []}
