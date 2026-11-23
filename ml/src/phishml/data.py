"""Dataset loading. See docs/ROADMAP.md T2."""
from __future__ import annotations

import pandas as pd

COLUMNS = ["sender", "body", "links", "label", "date", "source"]  # links: list[{"text","href"}]; label: 1=phish


def load_dataset(path: str) -> pd.DataFrame:
    """Return a DataFrame with COLUMNS. TODO(T2)."""
    raise NotImplementedError
