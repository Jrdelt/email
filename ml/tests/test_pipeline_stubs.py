import pytest

pytestmark = pytest.mark.skip(reason="pending roadmap tasks T2-T5; remove the skip when implementing")


def test_time_split_has_no_leakage():
    """T3: every test-row date >= every train-row date."""


def test_precision_at_fpr_perfect_scores():
    """T3: perfect separation gives precision 1.0."""


def test_onnx_matches_sklearn():
    """T5: ONNX output within 1e-5 of sklearn on fixtures."""
