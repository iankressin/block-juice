"""Reject physical table reads that are absent from the declared dbt dependency graph."""
from sqlglot import parse, exp
from sqlglot.errors import ParseError
from sqlglot.optimizer.scope import traverse_scope
from pipeline.analysis.executor import relations


def unknown_lineage(manifest, analysis_ids):
    failures = []
    for uid in analysis_ids:
        node = manifest["nodes"][uid]
        name = node.get("name", uid)
        if not node.get("depends_on", {}).get("nodes"):
            failures.append(f"{name}: no declared dependencies")
            continue
        code = node.get("compiled_code")
        if not code:
            failures.append(f"{name}: compiled SQL is missing")
            continue
        declared = set(relations(manifest, [uid]))
        try:
            statements = parse(code, read="postgres")
            if len(statements) != 1 or not isinstance(statements[0], exp.Query):
                failures.append(f"{name}: an analysis must be a single SELECT")
                continue
            for scope in traverse_scope(statements[0]):
                for table in scope.sources.values():
                    if not isinstance(table, exp.Table) or not isinstance(table.this, exp.Identifier):
                        continue
                    def identifier(key):
                        part = table.args.get(key)
                        if not isinstance(part, exp.Identifier):
                            return ""
                        return part.name if part.args.get("quoted") else part.name.lower()
                    if (identifier("db"), identifier("this")) not in declared:
                        failures.append(f"{name}: undeclared relation {table.sql(dialect='postgres')}")
        except ParseError as error:
            failures.append(f"{name}: lineage could not be parsed ({str(error).splitlines()[0]})")
    return sorted(set(failures))
