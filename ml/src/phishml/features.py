"""Email feature extraction. Mirror of extension/src/features.ts — keep in sync (parity-tested)."""
from __future__ import annotations

import re
from dataclasses import dataclass, asdict
from urllib.parse import urlparse

URGENCY = ("urgent", "immediately", "verify", "suspended", "locked", "password", "confirm", "act now", "expires")
IP_HOST = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")


@dataclass(frozen=True)
class Link:
    text: str
    href: str


def _host(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def _registrable(host: str) -> str:
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def extract_features(sender: str, body: str, links: list[Link]) -> dict[str, float]:
    lower = body.lower()
    mismatch = 0
    ip_links = 0
    punycode = 0
    for link in links:
        h = _host(link.href)
        if IP_HOST.match(h):
            ip_links += 1
        if "xn--" in h:
            punycode += 1
        shown = _host(link.text if "://" in link.text else "https://" + link.text.strip()) if "." in link.text else ""
        if shown and h and _registrable(shown) != _registrable(h):
            mismatch += 1
    sender_domain = sender.rsplit("@", 1)[-1].lower() if "@" in sender else ""
    external = sum(1 for l in links if sender_domain and _registrable(_host(l.href)) != _registrable(sender_domain))
    return {
        "n_links": float(len(links)),
        "n_text_href_mismatch": float(mismatch),
        "n_ip_links": float(ip_links),
        "n_punycode_links": float(punycode),
        "n_external_links": float(external),
        "urgency_hits": float(sum(lower.count(w) for w in URGENCY)),
        "body_len": float(len(body)),
    }


FEATURE_NAMES = list(extract_features("", "", []).keys())


def as_dict(f: dict[str, float]) -> dict[str, float]:
    return asdict(f) if hasattr(f, "__dataclass_fields__") else dict(f)
