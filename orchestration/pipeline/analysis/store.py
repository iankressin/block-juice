"""Immutable execution snapshots with a serialized, atomic current-run pointer.

The root answer files remain an editable compatibility projection. Execution snapshots
under runs never change; narrative/check/report editions are separately archived.
"""
import os
import time
import hashlib
import json
import shutil
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from pipeline.answer_artifacts import publish
from pipeline.cli import BadInput


_held_locks = ContextVar("answer_locks", default=frozenset())


@contextmanager
def answer_lock(folder: Path, *, shared=False):
    key = str(folder.resolve())
    if key in _held_locks.get():
        yield
        return
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / ".answer.lock").open("a") as lock:
        if os.name == "nt":
            import msvcrt
            if lock.tell() == 0:
                lock.write("\0")
                lock.flush()
            while True:
                try:
                    lock.seek(0)
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError as error:
                    if error.errno not in (13, 11, 36):
                        raise
                    time.sleep(0.05)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_SH if shared else fcntl.LOCK_EX)
        token = _held_locks.set(_held_locks.get() | {key})
        try:
            yield
        finally:
            _held_locks.reset(token)
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def current_run(folder):
    path = folder / "latest.json"
    if not path.exists():
        return None
    try:
        run = json.loads(path.read_text())["run_id"]
        if len(run) != 32 or any(c not in "0123456789abcdef" for c in run):
            raise ValueError("invalid run id")
        return run
    except (ValueError, KeyError, TypeError) as error:
        raise BadInput(f"{path}: invalid current-run pointer ({error})") from None


def atomic_json(path, value):
    temporary = path.with_name(f".{path.name}-{uuid4().hex}")
    try:
        temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def file_hashes(folder):
    return {str(path.relative_to(folder)): file_hash(path)
            for path in sorted(folder.rglob("*")) if path.is_file()}


class RunStore:
    def __init__(self, folder):
        self.folder = folder

    def publish(self, prepared):
        folder = self.folder
        with answer_lock(folder):
            runs = folder / "runs"
            runs.mkdir(exist_ok=True)
            document = json.loads((prepared / "answer.json").read_text())
            run_id = document.get("provenance", {}).get("run_id", uuid4().hex)
            if not isinstance(run_id, str) or len(run_id) != 32 or any(c not in "0123456789abcdef" for c in run_id):
                raise BadInput("run_id must be 32 lowercase hexadecimal characters")
            destination = runs / run_id
            if destination.exists():
                raise BadInput(f"execution run {run_id} already exists")
            try:
                shutil.copytree(prepared, destination)
                hashes = file_hashes(destination)
                (destination / "artifacts.json").write_text(json.dumps(hashes, indent=2) + "\n")
                publish(folder, prepared, on_published=lambda: atomic_json(folder / "latest.json", {"run_id": run_id}))
            except BaseException:
                shutil.rmtree(destination, ignore_errors=True)
                raise
            return run_id

    def record_edition(self, *, kind):
        """Called under the answer lock; snapshot narrative/check/report content without mutating a run."""
        run_id = current_run(self.folder)
        if not run_id:
            return
        base = self.folder / "editions" / run_id
        base.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(prefix=".edition-", dir=base) as temporary:
            prepared = Path(temporary)
            for name in ("answer.json", "answer.md", "reports"):
                source = self.folder / name
                if source.is_dir():
                    shutil.copytree(source, prepared / name)
                elif source.is_file():
                    shutil.copy2(source, prepared / name)
            (prepared / "edition.json").write_text(json.dumps({"run_id": run_id, "kind": kind,
                                                               "sha256": file_hashes(prepared)}, indent=2) + "\n")
            prepared.replace(base / uuid4().hex)


def verify_current_results(folder, answer):
    """Refuse accidental result/narrative reuse across generations; old saved answers remain readable."""
    run_id = current_run(folder)
    if not run_id:
        return
    run = folder / "runs" / run_id
    original = json.loads((run / "answer.json").read_text())
    # Explicit checks may be added later, but query results and their provenance belong to one run.
    for key in ("results", "provenance", "value", "answered_at"):
        if answer.get(key) != original.get(key):
            raise BadInput(f"saved answer {key} does not match run {run_id}; run bj answer again")
    hashes = json.loads((run / "artifacts.json").read_text())
    for result in answer.get("results", []):
        path = result["path"]
        current = folder / path
        if path not in hashes or not current.is_file() or file_hash(current) != hashes[path]:
            raise BadInput(f"saved result {path} does not match run {run_id}; run bj answer again")
