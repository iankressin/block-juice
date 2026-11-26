"""The build run's work-job steps, run as the workflow has them. Default-branch factory steps must also work with
a ticket branch's older bj command."""

import json
import os
import re
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
import re
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
import re
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


# The build run's own steps, run as the workflow has them. uv runs python and a stand-in bj for real and skips
# dbt; gh returns the ticket's comments. `uv run --project <dir> <tool> args` drops its first three words.
FAKE_UV = """\
#!/bin/sh
shift 3
tool=$1
shift
case "$tool" in
  python) exec {python} "$@" ;;
  bj) exec {python} {bj} "$@" ;;
  dbt) exit 0 ;;
esac
echo "fake uv: no tool $tool" >&2
exit 1
"""
# bj answer --eval as it can end: a fresh answer whose reference_match passed, or an error before any answer.
FAKE_BJ = """\
import json, os, sys
from datetime import datetime, timezone
from pathlib import Path
if os.environ["FAKE_BJ"] == "error":
    print("bj: error: the analysis by_pool returns no column swaps", file=sys.stderr)
    sys.exit(2)
folder = Path("answers") / sys.argv[2] / "eval"
folder.mkdir(parents=True, exist_ok=True)
check = {"name": "reference_match", "status": "passed", "detail": "0 mismatches over tolerance"}
(folder / "answer.json").write_text(json.dumps({"answered_at": datetime.now(timezone.utc).isoformat(), "checks": [check]}))
"""
BOT = "blockjuice-factory[bot]"
SCOPE = """\
slug: sample
question: How many swaps did each pool have?
oracle: {kind: dune, ref: Dune query 1234567, independent_of_portal: true, covers: Every swap in the window.}
window: {chain: ethereum, from: 2026-10-15T00:00:00Z, to: 2026-10-16T00:00:00Z, blocks: [23580000, 23587000]}
tolerance: {kind: absolute, value: 0}
reference: {key: [pool], value: swaps}
full_window: {from: 2026-10-01T00:00:00Z, to: 2026-11-01T00:00:00Z, blocks: 222450, estimate_minutes: 40}
duplicates: []
"""
REFERENCE = "pool,swaps\n0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640,4127\n"
QUESTION = """\
question: How many swaps did each pool have?
analyses: [by_pool]
reference: {analysis: by_pool, key: [pool], value: swaps, tolerance: {kind: absolute, value: 0}, oracle: Dune query 1234567}
"""
EXPRESSION = re.compile(r"^\$\{\{ steps\.([a-z_]+)\.outputs\.([a-z_]+) \}\}$")


def run_step(step_id, env, outputs, tmp_path):
    """Runs a work-job step with its env resolved from the outputs of the steps before it, and records its own."""
    step = next(step for step in STEPS if step.get("id") == step_id)
    wired = {name: outputs[m[1]][m[2]] for name, value in (step.get("env") or {}).items() if (m := EXPRESSION.match(str(value)))}
    output = tmp_path / f"{step_id}.output"
    output.write_text("")
    run_script(step["run"], {**env, **wired, "GITHUB_OUTPUT": str(output)}, tmp_path)
    outputs[step_id] = dict(line.split("=", 1) for line in output.read_text().splitlines())
    return outputs[step_id]


def build_run(tmp_path, bj):
    """The environment of a build run's work job up to the model step, with the scope comment read."""
    (tmp_path / "bj.py").write_text(FAKE_BJ)
    uv = tmp_path / "uv"
    uv.write_text(FAKE_UV.format(python=shlex.quote(sys.executable), bj=shlex.quote(str(tmp_path / "bj.py"))))
    gh = tmp_path / "gh"
    gh.write_text('#!/bin/sh\ncat "$FAKE_COMMENTS"\n')
    for fake in (uv, gh):
        fake.chmod(0o755)
    body = f"<!-- factory:scope -->\nThe scope.\n\n```yaml\n{SCOPE}```\n\n```csv\n{REFERENCE}```\n"
    comments = tmp_path / "comments.json"
    comments.write_text(json.dumps([[{"user": {"login": BOT, "type": "Bot"}, "body": body}]]))
    (tmp_path / "runner").mkdir()
    (tmp_path / "transformation").mkdir()
    env = {
        **os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}", "RUNNER_TEMP": str(tmp_path / "runner"),
        "GH_REPO": "owner/repo", "ISSUE": "12", "BOT": BOT, "FAKE_COMMENTS": str(comments), "FAKE_BJ": bj,
    }
    outputs = {"glue": {"dir": str(REPO / ".github/factory")}}
    run_step("scope", env, outputs, tmp_path)
    return env, outputs


def ship(tmp_path, question=QUESTION, reference=REFERENCE):
    folder = tmp_path / "answers/sample"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "question.yaml").write_text(question)
    (folder / "reference.csv").write_text(reference)


def test_the_verdict_of_a_reference_shipped_as_scoped_is_bjs(tmp_path):
    env, outputs = build_run(tmp_path, bj="pass")
    assert (tmp_path / ".factory/scope.yaml").read_text() == SCOPE
    assert (tmp_path / ".factory/reference.csv").read_text() == REFERENCE
    ship(tmp_path)
    verdict = run_step("verdict", env, outputs, tmp_path)
    assert (verdict["status"], verdict["kind"]) == ("passed", "passed")


def test_a_build_that_edits_the_reference_and_the_scope_files_gets_a_mismatch_before_bj_runs(tmp_path):
    env, outputs = build_run(tmp_path, bj="pass")
    widened = QUESTION.replace("value: 0}", "value: 5}")
    ship(tmp_path, widened, REFERENCE.replace(",4127", ",4100"))
    (tmp_path / ".factory/scope.yaml").write_text(SCOPE.replace("value: 0}", "value: 5}"))
    (tmp_path / ".factory/reference.csv").write_text(REFERENCE.replace(",4127", ",4100"))
    verdict = run_step("verdict", env, outputs, tmp_path)
    assert (verdict["status"], verdict["kind"]) == ("failed", "mismatch")
    assert verdict["detail"].startswith("answers/sample/reference.csv lacks 1 scope row(s), first 0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640,4127;")
    assert "answers/sample/question.yaml reference.tolerance is" in verdict["detail"]
    assert not (tmp_path / "answers/sample/eval/answer.json").exists()


def test_an_eval_run_that_ends_in_an_error_names_the_error_in_the_verdict(tmp_path):
    env, outputs = build_run(tmp_path, bj="error")
    ship(tmp_path)
    verdict = run_step("verdict", env, outputs, tmp_path)
    assert verdict == {
        "status": "failed", "kind": "not_run",
        "detail": "bj answer --eval wrote no answer.json: bj: error: the analysis by_pool returns no column swaps",
    }
