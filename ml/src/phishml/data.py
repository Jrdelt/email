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
    - scanLinks: each href unwrapped through redirect and link-protection wrappers as unwrapRedirect does
      (src/linkGuard.ts unwrapOnce, up to 4 hops, every hop's target an http(s) URL as isSafeHttpUrl accepts):
      - Defender Safe Links (*.safelinks.protection.outlook.com) url=; Facebook l.php / lm.facebook.com u=;
        YouTube /redirect q=; Barracuda linkprotect.cudasvc.com/url a=; Proofpoint v2 u= (-XX and _ decoding) and
        v3 (/v3/__<url>__;<token>, '*' and '**X' runs filled from the base64url token); Cisco Secure Email (the
        percent-decoded last path segment).
      - Google /url on the explicit GOOGLE_SUFFIXES list of Google's own country domains (www.google.co.uk, ...;
        never a google.<any TLD> pattern, so google.zz or google.evil.example stay wrapped): the names q then url,
        skipping empty values and values that are not http(s) URLs, the LAST usable value of the first name that
        has one. Only the last 16 values of a name are examined (a target before them is not unwrapped).
      - Google AMP: /amp/s/<host>/<path> becomes https://<host>/<path>, /amp/<host>/<path> http://..., the query
        string kept.
      - Bing /ck/a on www.bing.com, bing.com and cn.bing.com: u=a1<base64url UTF-8 target>; a value that cannot be
        decoded is not unwrapped.
      Link text is bounded as capLinkText does; text inside U+202E ... U+202C (or to the end) is reversed and that
      reading scored when it shows another host than the destination (linkTextReader/scoredText; CSS-hidden link
      text is a rendering concern of load_dataset, not of this function). Duplicate (href, whitespace-collapsed
      text) pairs are dropped, and past MAX_LINKS (1000) the risk-first sample is kept.
    The authoritative spec is unwrapRedirect plus the fixture: every rule above has a case there, so a mirror that
    misses one fails test_scoring_input_matches_the_extension. Any change to those steps in the extension updates
    the fixture, this function and its test together.
    """
    raise NotImplementedError
