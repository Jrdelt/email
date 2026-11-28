"""Evaluation. See docs/ROADMAP.md T3."""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd


@dataclass(frozen=True)
class OperatingPoint:
    """One decision threshold and what it does on the test set (flag an email when its score >= threshold)."""

    threshold: float  # math.inf when no threshold meets the false-positive budget
    precision: float  # 0.0 when nothing is flagged
    recall: float  # true-positive rate
    false_positives: int
    n_negatives: int
    n_positives: int


def time_split(df: pd.DataFrame, test_fraction: float = 0.2) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Split by `date` at one cutoff so that no train row is as new as any test row. TODO(T3).

    Contract (tests/test_pipeline_stubs.py):
    - Rows whose `date` is missing (NaT) are dropped, never put on either side; the caller reports how many.
    - `cutoff` is the date of the row at position floor((1 - test_fraction) * n) of the remaining rows in date
      order. train = rows with date < cutoff, test = rows with date >= cutoff. Rows sharing a timestamp (one
      campaign sent in one burst) therefore always land on the same side: max(train.date) < min(test.date).
    - Test rows whose body, case-folded with whitespace runs collapsed, also occurs in train are removed from
      test (re-sent campaigns and forwarded copies must not be scored as unseen mail).
    - Raises ValueError unless both labels occur in both splits. Public ham and phishing corpora often cover
      different years; one global cut would then put all ham in train and all phish in test, make the test FPR
      undefined and let `date` stand in for the label.
    """
    raise NotImplementedError


def precision_at_fpr(y_true, y_score, max_fpr: float = 0.001) -> OperatingPoint:
    """The operating point with the largest recall whose false-positive rate on the test negatives is <= max_fpr.
    TODO(T3).

    Contract (tests/test_pipeline_stubs.py):
    - Candidate thresholds are the distinct scores; an email is flagged when score >= threshold, so tied scores
      are flagged together and a tie is never split to fit the budget.
    - Among the thresholds within the budget, take the largest recall, and among those the highest threshold
      (fewest false positives).
    - This is NOT "the best precision over thresholds with FPR <= max_fpr": a threshold above every negative
      gives precision 1.0 for any model that ranks a single phish first, so that number cannot tell a weak model
      from a good one.
    - When no threshold within the budget flags a phish, threshold is math.inf, nothing is flagged, and
      precision and recall are 0.0.
    - Raises ValueError when there are fewer than 1 / max_fpr negatives (1000 at 0.1%): below that the budget
      only means "zero false positives" and the result is not a 0.1% FPR measurement.
    - Precision depends on the test set's phish:ham ratio, which in public corpora is far higher than in real
      inboxes: report recall next to it (and precision re-weighted to a stated deployment prevalence).
    """
    raise NotImplementedError
