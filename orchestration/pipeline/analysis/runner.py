"""Analysis execution coordinates contracts, compilation, checks, reads and publication."""
from dataclasses import replace, asdict
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
from pipeline.analysis.domain import Check
from pipeline.analysis.provenance import run_provenance
from pipeline.analysis.executor import ancestors
from pipeline.analysis.lineage import unknown_lineage
from pipeline.cli.question import WindowKey


def apply_freshness_policy(check, question, last_runs, context, manifest, analysis_ids):
    policy = question.freshness
    if not policy:
        return replace(check, detail=check.detail + "; no age/build freshness requirement declared")
    failures = []
    now = datetime.now(timezone.utc)
    age = policy.get("max_age_hours")
    if age is not None:
        for source, run in last_runs.items():
            if run and (now - run.finished_at.replace(tzinfo=run.finished_at.tzinfo or timezone.utc)).total_seconds() > age * 3600:
                failures.append(f"{source.name} exceeds {age} hours")
    if policy.get("require_model_build", False):
        builds = context.get("model_builds", {})
        for uid in sorted(ancestors(manifest, analysis_ids)):
            node = manifest.get("nodes", {}).get(uid, {})
            if node.get("resource_type") != "model" or node.get("config", {}).get("materialized") in {"view", "ephemeral"}:
                continue
            dependencies = ancestors(manifest, [uid])
            input_names = {f"{source['source_name']}.{source['name']}" for key, source in manifest.get("sources", {}).items()
                           if key in dependencies and "source_name" in source}
            latest_input = max((run.finished_at.timestamp() for source, run in last_runs.items()
                                if run and (not input_names or source.name in input_names)), default=0)
            build = builds.get(uid)
            if not build or build["status"] != "success":
                failures.append(f"{uid} has no successful latest recorded build")
            elif not build.get("started_at"):
                failures.append(f"{uid} has no recorded build start")
            elif datetime.fromisoformat(build["started_at"].replace("Z", "+00:00")).timestamp() < latest_input:
                failures.append(f"{uid} was built before the latest input load completed")
    detail = check.detail + ("; " + "; ".join(failures) if failures else "; declared age/build policy satisfied")
    return replace(check, passed=check.passed and not failures, detail=detail)


def run(api, repo_root: Path, slug: str, window_key: WindowKey = "window") -> int:
    question = api.load_question(repo_root, slug, window_key)
    api.require_env()
    project = repo_root / "transformation"
    arguments = (project, question.analyses, question.blocks)
    manifest, analysis_ids = api.compile_analyses(*arguments, **({"parameters": question.parameters} if question.parameters else {}))
    inputs = api.upstream_inputs(manifest, analysis_ids)
    unknown = unknown_lineage(manifest, analysis_ids)
    check_started = datetime.now(timezone.utc)
    streams = api.stream_inputs(question, inputs, api.coverage.sources(repo_root), api.coverage.stream_sources(repo_root))
    coverages = {name: api.coverage.read(repo_root, name) for name in sorted({i.source for i in streams})}
    above = api.upstream_tests(manifest, analysis_ids)
    stale = api.stale_tests(above, *api.dagster_history(manifest, above))
    test_variables = dict(question.parameters)
    if question.blocks:
        test_variables["window"] = question.blocks
    tests = api.run_dbt_tests(project, question.analyses, coverages, [manifest["nodes"][t]["name"] for t in stale],
                              **({"parameters": test_variables} if test_variables else {}))
    if len(stale) < len(above):
        tests = replace(tests, detail=f"{tests.detail}; {len(above) - len(stale)} upstream passed since the marts were built")
    check_finished = datetime.now(timezone.utc)
    results, dead_letters, last_runs = api.read_warehouse(manifest, analysis_ids, inputs,
        policy=question.execution, expected_columns=question.expected_columns, grain=question.grain)
    checks = [tests, api.dead_letters_check(dead_letters), api.freshness_check(last_runs)]
    checks[-1] = apply_freshness_policy(checks[-1], question, last_runs, getattr(results, "context", {}), manifest, analysis_ids)
    if unknown:
        checks.append(Check("lineage", False, "; ".join(unknown) + "; use ref/source or explicit dbt -- depends_on hints"))
    if streams:
        if question.window.get("scope") == "loaded":
            checks.append(Check("coverage", True, "loaded rows only; historical completeness is not asserted"))
        else:
            checks.append(api.coverage_check(streams, coverages, question.blocks, question.window_key))
    document = api.answer_document(
        question, datetime.now(timezone.utc), results, dead_letters, last_runs, checks, {**api.provenance(repo_root), "run_id": uuid4().hex, **run_provenance(repo_root, question, manifest, analysis_ids, results, coverages, check_started, check_finished)}
    )
    folder = repo_root / "answers" / slug
    if window_key == "eval_window":
        folder = folder / "eval"
    try:
        api.write_answer(folder, results, document, artifacts={"manifest.json": manifest, "spec.json": asdict(question),
            "question.yaml": question.authored_text or ""})
    finally:
        if hasattr(results, "close"):
            results.close()

    value = document["value"]
    first = results[0]
    scalar = len(first.columns) == 1 and (first.row_count if first.row_count is not None else len(first.rows)) == 1
    missing = "null" if scalar else "none (the first analysis is not one row of one column)"
    print(f"value: {value if value is not None else missing}")
    for check in checks:
        print(f"{check.name}: {'passed' if check.passed else 'FAILED'} ({check.detail})")
    relative = folder.relative_to(repo_root)
    print(f"wrote {relative}/answer.json and {len(results)} CSV file(s) in {relative}/results/")
    return 0 if all(check.passed for check in checks) else 1
