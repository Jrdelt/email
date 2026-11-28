"""scoring_input.json: raw email fields -> the (body, links) the extension scores -> features.

The extension never scores the raw fields: it prepends the subject, normalises and bounds the visible text,
unwraps redirect wrappers and drops duplicate links (src/adapters/extract.ts, src/linkGuard.ts). The TypeScript
suite checks the expected values against that code (src/adapters/scoringInput.test.ts); this one checks that
features agree on them and, once T2 implements it, that data.scoring_input reproduces them.
"""
import json
from pathlib import Path

import pytest

from phishml.data import COLUMNS
from phishml.features import FEATURE_NAMES, Link, extract_features

CASES = json.loads((Path(__file__).parent / "fixtures" / "scoring_input.json").read_text(encoding="utf-8"))


def _links(items):
    return [Link(text=item["text"], href=item["href"]) for item in items]


def test_schema_has_the_fields_the_extension_scores():
    assert {"sender", "subject", "body", "links"} <= set(COLUMNS)
    assert len(CASES) >= 5
    for case in CASES:
        assert sorted(case["expected_features"]) == sorted(FEATURE_NAMES)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_features_of_the_scored_input(case):
    got = extract_features(case["sender"], case["expected_input"]["body"], _links(case["expected_input"]["links"]))
    assert got == case["expected_features"]


def test_raw_fields_are_not_the_scored_input():
    """Why scoring_input exists: features of the raw row differ from what the browser computes."""
    case = next(c for c in CASES if c["name"] == "urgent_subject_and_duplicate_safelinks")
    raw = extract_features(case["sender"], case["body"], _links(case["links"]))
    want = case["expected_features"]
    assert (raw["urgency_hits"], raw["n_text_href_mismatch"], raw["n_external_links"]) == (0, 2, 2)
    assert (want["urgency_hits"], want["n_text_href_mismatch"], want["n_external_links"]) == (5, 0, 0)


@pytest.mark.xfail(raises=NotImplementedError, strict=True, reason="pending roadmap T2; remove when implemented")
@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_scoring_input_matches_the_extension(case):
    from phishml.data import scoring_input

    sender, body, links = scoring_input(case["sender"], case["subject"], case["body"], _links(case["links"]))
    assert sender == case["sender"]
    assert body == case["expected_input"]["body"]
    assert links == _links(case["expected_input"]["links"])
    assert extract_features(sender, body, links) == case["expected_features"]
