"""Acceptance tests for the pipeline stubs (roadmap T3/T5), with their real assertions written ahead of the code.

Each test is a strict xfail that expects NotImplementedError: while the stub raises it the test is an expected
failure, a wrong implementation fails on its assertions, and a correct one turns into a strict XPASS failure until
its marker is removed. So no test here can pass without checking anything.
"""
import hashlib
import importlib
import json
import math
from pathlib import Path

import pandas as pd
import pytest

from phishml.features import FEATURE_NAMES

pending = pytest.mark.xfail(raises=NotImplementedError, strict=True, reason="pending roadmap task; remove when implemented")


@pytest.mark.parametrize(
    "module", ["phishml", "phishml.features", "phishml.data", "phishml.evaluate", "phishml.train", "phishml.export_model"]
)
def test_pipeline_modules_import(module):
    importlib.import_module(module)


def _frame(dates, labels, bodies=None):
    n = len(dates)
    return pd.DataFrame(
        {
            "sender": [f"s{i}@example.com" for i in range(n)],
            "body": bodies if bodies is not None else [f"message {i}" for i in range(n)],
            "links": [[] for _ in range(n)],
            "label": labels,
            "date": pd.to_datetime(dates),
            "source": ["synthetic"] * n,
        }
    )


@pending
def test_time_split_has_no_leakage():
    """T3: a strict cut at a date; rows sharing a timestamp never straddle it."""
    from phishml.evaluate import time_split

    # 10 rows; position floor(0.8 * 10) = 8 falls inside the three-row 2024-01-07 burst.
    dates = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-06"]
    dates += ["2024-01-07"] * 3 + ["2024-01-08"]
    labels = [0, 1, 0, 1, 0, 1, 1, 0, 1, 0]
    train, test = time_split(_frame(dates, labels), test_fraction=0.2)
    assert train["date"].max() < test["date"].min()
    assert len(train) + len(test) == 10
    assert (test["date"] == pd.Timestamp("2024-01-07")).sum() == 3
    assert set(train["label"]) == {0, 1} and set(test["label"]) == {0, 1}


@pending
def test_time_split_drops_undated_rows_and_train_duplicates():
    """T3: NaT rows go nowhere; a test body already in train (case/whitespace aside) is removed from test."""
    from phishml.evaluate import time_split

    dates = ["2024-01-01", "2024-01-02", "2024-01-03", None, "2024-01-04", "2024-01-05", "2024-01-06"]
    labels = [0, 1, 0, 1, 1, 0, 1]
    bodies = ["ham a", "Verify your account now", "ham b", "undated", "ham c", "ham d", "  VERIFY your\taccount  now "]
    train, test = time_split(_frame(dates, labels, bodies), test_fraction=0.5)
    assert "undated" not in set(train["body"]) | set(test["body"])
    assert train["date"].max() < test["date"].min()
    assert "  VERIFY your\taccount  now " not in set(test["body"])


@pending
def test_time_split_needs_both_classes_on_both_sides():
    """T3: old ham + new phish (typical public-corpus mix) must not silently become train=ham, test=phish."""
    from phishml.evaluate import time_split

    dates = [f"2004-01-{d:02d}" for d in range(1, 9)] + ["2019-01-01", "2019-01-02"]
    with pytest.raises(ValueError):
        time_split(_frame(dates, [0] * 8 + [1] * 2), test_fraction=0.2)


@pending
def test_precision_at_fpr_perfect_scores():
    """T3: perfect separation gives precision 1.0 and recall 1.0, without spending the false-positive budget."""
    from phishml.evaluate import precision_at_fpr

    y_true = [0] * 1000 + [1] * 50
    y_score = [i / 10_000 for i in range(1000)] + [0.5 + i / 1000 for i in range(50)]
    point = precision_at_fpr(y_true, y_score, max_fpr=0.001)
    assert point.precision == 1.0 and point.recall == 1.0
    assert point.false_positives == 0 and point.threshold == 0.5
    assert (point.n_negatives, point.n_positives) == (1000, 50)


@pending
def test_precision_at_fpr_does_not_reward_a_weak_model():
    """T3: ranking one phish first must not score 1.0 (the 'best precision over thresholds' trap)."""
    from phishml.evaluate import precision_at_fpr

    # One phish on top, then negatives and phish strictly alternating: a near-random ranking.
    y_true, y_score = [1], [1.0]
    for i in range(1000):
        y_true += [0, 1] if i < 999 else [0]
        y_score += [0.999 - 2e-6 * i, 0.999 - 2e-6 * i - 1e-6] if i < 999 else [0.999 - 2e-6 * i]
    point = precision_at_fpr(y_true, y_score, max_fpr=0.001)
    # Largest recall with FP <= 1: the top phish, the first negative and the phish after it.
    assert point.false_positives == 1
    assert point.precision == pytest.approx(2 / 3)
    assert point.recall == pytest.approx(2 / 1000)


@pending
def test_precision_at_fpr_never_splits_a_tie():
    """T3: tied scores are flagged together; when that breaks the budget nothing qualifies."""
    from phishml.evaluate import precision_at_fpr

    one_tied = precision_at_fpr([1] * 10 + [0] + [0] * 999, [0.9] * 11 + [0.1] * 999, max_fpr=0.001)
    assert (one_tied.false_positives, one_tied.threshold) == (1, 0.9)
    assert one_tied.precision == pytest.approx(10 / 11) and one_tied.recall == 1.0

    two_tied = precision_at_fpr([1] * 10 + [0, 0] + [0] * 998, [0.9] * 12 + [0.1] * 998, max_fpr=0.001)
    assert math.isinf(two_tied.threshold)
    assert (two_tied.precision, two_tied.recall, two_tied.false_positives) == (0.0, 0.0, 0)


@pending
def test_precision_at_fpr_needs_enough_negatives():
    """T3: with fewer than 1/max_fpr negatives a 0.1% FPR cannot be measured."""
    from phishml.evaluate import precision_at_fpr

    with pytest.raises(ValueError):
        precision_at_fpr([0] * 999 + [1], [0.0] * 999 + [1.0], max_fpr=0.001)


@pending
def test_exported_json_matches_sklearn(tmp_path: Path):
    """T5: exported JSON model matches sklearn within 1e-6 on fixtures, is < 200 KB, and its hash is returned."""
    from sklearn.linear_model import LogisticRegression

    from phishml.export_model import export, reference_score
    from phishml.features import Link, extract_features

    fixtures = json.loads((Path(__file__).parent / "fixtures" / "parity.json").read_text(encoding="utf-8"))
    rows = [c["expected"] for c in fixtures]
    rows.append(extract_features("a@bank.example", "URGENT verify", [Link("www.bank.example", "http://1.2.3.4/")]))
    x = pd.DataFrame(rows, columns=FEATURE_NAMES)
    y = [i % 2 for i in range(len(rows))]
    model = LogisticRegression(max_iter=1000).fit(x, y)

    out = tmp_path / "model.json"
    digest = export(model, str(out))
    data = out.read_bytes()
    assert digest == hashlib.sha256(data).hexdigest()
    assert len(data) < 200 * 1024
    model_json = json.loads(data)
    expected = model.predict_proba(x)[:, 1]
    for features, want in zip(rows, expected):
        assert reference_score(model_json, features) == pytest.approx(want, abs=1e-6)
