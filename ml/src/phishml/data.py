"""Dataset loading. See docs/ROADMAP.md T2."""
from __future__ import annotations

import pandas as pd

from phishml.features import Link

# One row per email. The fields are what the extension reads from a rendered message, so that features computed for
# training are the features the browser computes:
# - sender: the bare From address (the extension scores `sender.address`, never the display name).
# - subject: the decoded Subject header.
# - body: the message's visible text (HTML rendered to text, skipping style/script/noscript/template), not HTML.
# - links: list[{"text", "href"}] for every <a>/<area> href, as the browser resolves it, with its shown text.
# - label: 1 = phishing, 0 = legitimate. date: when the email was sent. source: which corpus it came from.
COLUMNS = ["sender", "subject", "body", "links", "label", "date", "source"]


def load_dataset(path: str) -> pd.DataFrame:
    """Return a DataFrame with COLUMNS. TODO(T2)."""
    raise NotImplementedError


def scoring_input(sender: str, subject: str, body: str, links: list[Link]) -> tuple[str, str, list[Link]]:
    """The (sender, body, links) the extension scores for this email. TODO(T2).

    train.py and evaluate.py compute features only as extract_features(*scoring_input(...)): the raw columns are
    not what the browser scores. The contract is tests/fixtures/scoring_input.json, which the TypeScript suite
    checks against the real extension code (src/adapters/scoringInput.test.ts) and tests/test_scoring_input.py
    against this function. It mirrors, exactly:
    - withSubject (src/adapters/extract.ts): the first 300 UTF-16 code units of the subject, "\\n", then the body.
    - bodyText: characters that render as nothing (INVISIBLE_RE) dropped, whitespace runs collapsed to one space,
      and past MAX_BODY_CHARS (20,000) only the first and last halves.
    - scanLinks: each href unwrapped through redirect and link-protection wrappers as unwrapRedirectUrl does
      (src/linkGuard.ts: Safe Links, google.com/url with the LAST duplicate parameter, Proofpoint v2/v3, Barracuda,
      Cisco, Facebook, YouTube; up to 4 hops), link text bounded as capLinkText does, duplicate (href,
      whitespace-collapsed text) pairs dropped, and past MAX_LINKS (1000) the risk-first sample.
    Any change to those steps in the extension updates the fixture, this function and its test together.
    """
    raise NotImplementedError
