"""Publish prepared answer files while retaining one complete previous answer."""

import shutil
from pathlib import Path
from uuid import uuid4


OUTPUTS = ("answer.md", "reports", "results", "answer.json")


def remove(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def publish(folder: Path, prepared: Path) -> None:
    """Serialization finishes before publication. An ordinary filesystem error restores the old
    files; backups stay outside temporary storage so even a failed restore leaves them recoverable.
    The old narrative leaves first, before any new data can reach the report renderer.
    """
    folder.mkdir(exist_ok=True)
    previous = folder / "previous"
    older = folder / f".previous-{uuid4().hex}"
    saved, published = [], []
    had_previous = previous.exists()
    if had_previous:
        previous.replace(older)
    try:
        previous.mkdir()
        for name in OUTPUTS:
            current = folder / name
            if current.exists():
                current.replace(previous / name)
                saved.append(name)
        for name in OUTPUTS:
            new = prepared / name
            if new.exists():
                new.replace(folder / name)
                published.append(name)
    except OSError:
        for name in reversed(published):
            remove(folder / name)
        for name in reversed(saved):
            (previous / name).replace(folder / name)
        if previous.exists():
            previous.rmdir()
        if had_previous:
            older.replace(previous)
        raise
    if not saved:
        previous.rmdir()
    if had_previous:
        # The current and immediately preceding answers are complete even if an older backup
        # cannot be removed, so a cleanup failure must not turn this publication into a failure.
        shutil.rmtree(older, ignore_errors=True)
