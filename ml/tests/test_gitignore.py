"""The repository's ignore rules keep raw data out of commits.

`git check-ignore --no-index` tests the rules themselves (not whether a path happens to be tracked), from the
repository root. Skipped outside a git checkout (for example an unpacked sdist).
"""
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True, check=False)


def _in_checkout() -> bool:
    if shutil.which("git") is None:
        return False
    top = _git("rev-parse", "--show-toplevel")
    return top.returncode == 0 and Path(top.stdout.strip()).resolve() == REPO


pytestmark = pytest.mark.skipif(not _in_checkout(), reason="needs git and a checkout of this repository")


def _ignored(path: str) -> bool:
    result = _git("check-ignore", "--no-index", "-q", path)
    assert result.returncode in (0, 1), result.stderr
    return result.returncode == 0


# Everything under ml/data/ except the provenance file: downloaded corpora hold third-party email content,
# addresses and live phishing URLs, and their licences may forbid redistribution (AGENTS.md "Data").
@pytest.mark.parametrize(
    "path",
    [
        "ml/data/raw/probe.csv",
        "ml/data/raw/nested/corpus.mbox",
        "ml/data/processed/probe.parquet",
        "ml/data/enron.csv",
        "ml/data/sample.eml",
    ],
)
def test_ml_data_is_ignored(path):
    assert _ignored(path)


def test_ml_data_sources_stays_tracked():
    assert not _ignored("ml/data/SOURCES.md")


def test_no_tracked_file_matches_an_ignore_rule():
    listed = _git("ls-files", "-ci", "--exclude-standard")
    assert listed.returncode == 0, listed.stderr
    assert listed.stdout == ""
