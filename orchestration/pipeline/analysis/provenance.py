"""Content hashes and explicit observation boundaries for reproducible saved answers."""
import hashlib
import json
import os
from collections.abc import Iterable
from dataclasses import asdict
from pathlib import Path
from pipeline.analysis.domain import jsonable
from pipeline.analysis.executor import ancestors


def digest(value):
    content = json.dumps(jsonable(value), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(content).hexdigest()


def authored_files(nodes: Iterable[dict]) -> dict[str, str]:
    # A seed's raw_code is empty, so its hash must come from dbt's checksum or every seed hashes the same.
    authored = {}
    for node in nodes:
        if not node or not node.get("original_file_path"):
            continue
        if node.get("resource_type") == "seed":
            authored[node["original_file_path"]] = node["checksum"]["checksum"]
        elif "raw_code" in node:
            authored[node["original_file_path"]] = hashlib.sha256(node["raw_code"].encode()).hexdigest()
    return authored


def run_provenance(repo_root, question, manifest, analysis_ids, results, coverages, check_started, check_finished):
    nodes = {uid: manifest.get("nodes", {}).get(uid, manifest.get("sources", {}).get(uid))
             for uid in sorted(ancestors(manifest, analysis_ids))}
    captured = manifest.get("_blockjuice", {})
    authored = authored_files(nodes.values())
    config = captured.get("project_files_sha256", {})
    sql = {result.analysis: hashlib.sha256(result.sql.encode()).hexdigest() for result in results}
    return {"question_sha256": question.authored_sha256,
            "spec_sha256": digest(asdict(question)), "parameters": jsonable(question.parameters),
            "parameters_sha256": digest(question.parameters), "compiled_sql_sha256": sql,
            "manifest_sha256": digest(manifest), "dependency_graph_sha256": digest(nodes),
            "authored_files_sha256": authored, "project_files_sha256": config,
            "warehouse": {key: os.environ.get(key) for key in ("WAREHOUSE_DB", "RAW_SCHEMA", "DBT_SCHEMA")},
            "coverage_observations": {name: coverage.to_json() for name, coverage in coverages.items()},
            "snapshot": getattr(results, "context", {"isolation": "unknown"}),
            "external_checks": {"started_at": jsonable(check_started), "finished_at": jsonable(check_finished),
                                "snapshot": "separate connections before the result snapshot; not snapshot-certified"}}
