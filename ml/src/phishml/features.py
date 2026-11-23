"""Email feature extraction. Mirror of extension/src/features.ts — keep in sync (parity-tested)."""
from __future__ import annotations

import re
from dataclasses import dataclass, asdict
from urllib.parse import urlparse

URGENCY = ("urgent", "immediately", "verify", "suspended", "locked", "password", "confirm", "act now", "expires")
IP_HOST = re.compile(r"^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$")
EXPLICIT_URL = re.compile(r"https?://[^\s<>\"'()]+", re.IGNORECASE)
DOMAIN_RE = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")

MULTI_SUFFIXES = frozenset({
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au",
    "co.nz", "co.jp", "ne.jp", "or.jp", "com.br", "com.cn", "com.mx", "co.in", "co.za", "com.sg",
    "com.tr", "co.kr", "com.hk", "com.tw", "com.ar", "co.id", "com.my", "com.ph", "com.vn",
})

# Intentionally omits common non-web file extensions (pdf, js, py, sh, pl, rs, md, zip, mov).
COMMON_TLDS = frozenset({
    "com", "net", "org", "edu", "gov", "mil", "int", "io", "co", "ai", "app", "dev", "me",
    "us", "uk", "ca", "au", "de", "fr", "jp", "cn", "br", "in", "nl", "es", "it", "se",
    "ch", "ru", "kr", "nz", "za", "mx", "sg", "hk", "tw", "eu", "be", "at", "cz", "dk",
    "no", "fi", "ie", "pt", "gr", "tr", "il", "ae", "sa", "ar", "cl", "id", "my", "ph",
    "th", "vn", "info", "biz", "xyz", "top", "site", "online", "store", "shop", "club",
    "live", "cloud", "tech", "page", "link", "click", "pro", "tv", "gg", "cc", "ly", "to",
    "bank", "support", "security", "login", "account", "mail", "email", "news", "work",
    "life", "world", "today", "digital", "agency", "services", "solutions", "network",
    "systems", "center", "company", "group", "finance", "pay", "example", "test",
})


@dataclass(frozen=True)
class Link:
    text: str
    href: str


def _is_valid_domain(domain: str) -> bool:
    return len(domain) <= 253 and bool(DOMAIN_RE.match(domain))


def _host(url: str) -> str:
    try:
        p = urlparse(url)
        return (p.hostname or "").lower() if p.scheme in ("http", "https") else ""
    except ValueError:
        return ""


def _registrable(host: str) -> str:
    parts = [p for p in host.lower().removesuffix(".").split(".") if p]
    if len(parts) <= 2:
        return ".".join(parts)
    n = 3 if ".".join(parts[-2:]) in MULTI_SUFFIXES else 2
    return ".".join(parts[-n:])


def shown_host(text: str) -> str:
    """Extract a hostname only when link text looks like an explicit URL or bare domain/IP."""
    t = text.strip()
    if not t:
        return ""
    m = EXPLICIT_URL.search(t)
    if m:
        candidate = re.sub(r"[.,;:!?]+$", "", m.group(0))
        h = _host(candidate)
        return h if (_is_valid_domain(h) or IP_HOST.match(h)) else ""
    if re.search(r"\s", t):
        return ""
    authority = re.split(r"[/?#]", t, maxsplit=1)[0]
    if "@" in authority or "://" in authority or authority.endswith("."):
        return ""
    raw_host = re.sub(r":\d{1,5}$", "", authority).lower()
    if IP_HOST.match(raw_host):
        return raw_host
    if not _is_valid_domain(raw_host):
        return ""
    tld = raw_host.rsplit(".", 1)[-1]
    return raw_host if (raw_host.startswith("www.") or tld in COMMON_TLDS) else ""


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
        shown = shown_host(link.text)
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
