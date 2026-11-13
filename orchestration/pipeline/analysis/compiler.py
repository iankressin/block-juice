"""dbt compilation owns its manifest and variables, independent of CLI and warehouse access."""
import json
import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
from pipeline.cli import BadInput


class QueryCompiler:
    def __init__(self, invoke, error_text):
        self.invoke, self.error_text = invoke, error_text

    def compile(self, project: Path, names, blocks, parameters=None):
        def configuration():
            return {name: hashlib.sha256((project / name).read_bytes()).hexdigest()
                    for name in ("dbt_project.yml", "profiles.yml", "packages.yml", "package-lock.yml")
                    if (project / name).is_file()}
        before = configuration()
        values = dict(parameters or {})
        if blocks:
            values["window"] = blocks
        variables = ("--vars", json.dumps(values)) if values else ()
        with TemporaryDirectory(prefix="bj-answer-") as temporary:
            target = Path(temporary)
            result = self.invoke(project, "compile", "--select", *names, *variables,
                                 "--target-path", str(target), "--log-path", str(target / "logs"))
            if not result.success:
                raise BadInput(f"dbt compile failed: {self.error_text(result)}")
            manifest = json.loads((target / "manifest.json").read_text())
        after = configuration()
        if before != after:
            raise BadInput("dbt project configuration changed during compilation; retry the answer")
        manifest["_blockjuice"] = {"project_files_sha256": after}
        analyses = {n["name"]: uid for uid, n in manifest["nodes"].items() if n["resource_type"] == "analysis"}
        for name in names:
            if name not in analyses:
                raise BadInput(f"no dbt analysis named {name}: write transformation/analyses/{name}.sql")
        return manifest, [analyses[name] for name in names]
