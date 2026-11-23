"""Evaluation. See docs/ROADMAP.md T3."""
from __future__ import annotations

import pandas as pd


def time_split(df: pd.DataFrame, test_fraction: float = 0.2) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Split by `date` (oldest -> train, newest -> test). TODO(T3)."""
    raise NotImplementedError


def precision_at_fpr(y_true, y_score, max_fpr: float = 0.001) -> float:
    """Best precision achievable at false-positive rate <= max_fpr. TODO(T3)."""
    raise NotImplementedError
