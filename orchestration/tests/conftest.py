import pytest


@pytest.fixture(autouse=True)
def dagster_home(tmp_path_factory, monkeypatch):
    """Keeps the runs tests make out of the checkout's own Dagster history, where bj puts them by default."""
    monkeypatch.setenv("DAGSTER_HOME", str(tmp_path_factory.mktemp("dagster_home")))
