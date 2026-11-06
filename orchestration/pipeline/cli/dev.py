"""bj dev: bj install, then the compose stack and bj doctor's checks, then `dagster dev` in place of bj."""

import os
import sys
from pathlib import Path

from pipeline.cli import BadInput, doctor, install

DOCKER_INSTALL_HINT = "install Docker with the compose plugin"
COMPOSE_UP = ["docker", "compose", "up", "-d"]
# Not `up --wait`: on Compose v5.4.0 it exits 1 once the one-shot warehouse-init exits 0. `wait` returns
# warehouse-init's own exit code, and warehouse-init runs only once the warehouse is healthy.
WAIT_FOR_INIT = ["docker", "compose", "wait", "warehouse-init"]


def run(repo_root: Path) -> int:
    if doctor.port_open(doctor.DAGSTER_PORT):
        raise BadInput(f"port {doctor.DAGSTER_PORT} is in use, so dagster dev is probably running already")
    code = install.setup(repo_root)
    if code:
        return code
    if not install.run_command(COMPOSE_UP, repo_root, DOCKER_INSTALL_HINT):
        return 1
    if not install.run_command(WAIT_FOR_INIT, repo_root, DOCKER_INSTALL_HINT):
        print("`docker compose logs warehouse-init` shows why it failed")
        return 1
    if doctor.run(repo_root, copy_env=False, ports=doctor.COMPOSE_PORTS):
        print("dagster dev did not start: fix each FAIL above, then run bj dev again")
        return 1
    print("running `dagster dev` in orchestration/")
    # exec replaces this process without flushing Python's buffers.
    sys.stdout.flush()
    sys.stderr.flush()
    os.chdir(repo_root / "orchestration")
    # Not subprocess.run: on Ctrl-C it kills Dagster before Dagster can stop its daemon and code servers.
    os.execvp("dagster", ["dagster", "dev"])
