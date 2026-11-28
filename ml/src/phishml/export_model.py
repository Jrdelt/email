"""Model export to compact JSON. See docs/ROADMAP.md T5."""
from __future__ import annotations


def export(model, out_path: str) -> str:
    """Write model.json (compact weights/trees, < 200 KB) and return its SHA-256 (hex). TODO(T5)."""
    raise NotImplementedError


def reference_score(model_json: dict, features: dict[str, float]) -> float:
    """Pure-Python reference evaluator of an exported model: the phishing probability for one feature dict
    (FEATURE_NAMES keys). Must match the sklearn model within 1e-6; src/model.ts must match it (T6). TODO(T5)."""
    raise NotImplementedError
