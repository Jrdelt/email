"""Email feature extraction. Mirror of extension/src/features.ts — keep in sync (parity-tested)."""
from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import unquote, urlsplit

URGENCY = (
    "urgent", "immediately", "verify", "suspended", "locked", "password", "confirm", "act now", "expires",
    "expiration", "expired", "will be deleted", "billing details", "payment method", "unauthorized",
    "unusual activity", "action required", "temporarily limited", "limited access", "within 24 hours",
    "within 48 hours", "avoid interruption", "avoid suspension", "restore access", "unrecognized device",
    "sign-in attempt",
)
IP_LOGGER_HOSTS = frozenset({
    "urlto.me", "grabify.link", "grabify.icu", "stopify.co", "hd.gd", "onbit.pro", "snifferip.com", "unl.one",
    "iplogger.org", "iplogger.com", "2no.co", "yip.su", "ezstat.ru", "leancoding.co", "quickmessage.us",
    "spoofer.us", "ps3cfw.com", "bmwforum.co", "blasze.com",
})
SHORTENER_HOSTS = frozenset({
    "bit.ly", "tinyurl.com", "t.co", "rebrand.ly", "rb.gy", "cutt.ly", "shorturl.at", "is.gd",
    "ow.ly", "goo.gl", "buff.ly", "tiny.cc", "bl.ink", "s.id", "v.gd", "clck.ru", "t.ly", "surl.li",
    "lnkd.in", "mcaf.ee", "su.pr", "adf.ly", "bc.vc", "ouo.io", "shrinke.me",
})
IP_V4_RE = re.compile(r"^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\Z", re.ASCII)
IPV6_CHARS_RE = re.compile(r"^[0-9a-f:.]+\Z", re.IGNORECASE | re.ASCII)
BRACKETED_IPV6_RE = re.compile(r"^\[([0-9a-f:.]+)\](?::\d{1,5})?\Z", re.IGNORECASE | re.ASCII)
PORT_SUFFIX_RE = re.compile(r":\d{1,5}\Z", re.ASCII)
EXPLICIT_URL = re.compile(r"https?://[^\s<>\"'()]+", re.IGNORECASE | re.ASCII)
DOMAIN_RE = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z", re.ASCII)

CLOUD_STORAGE_HOSTS = frozenset({
    "storage.googleapis.com",
    "storage.cloud.google.com",
    "firebasestorage.googleapis.com",
    "ipfs.io",
    "cloudflare-ipfs.com",
    "gateway.pinata.cloud",
    "s3.amazonaws.com",
})
CLOUD_STORAGE_SUFFIXES = (
    ".s3.amazonaws.com",
    ".blob.core.windows.net",
    ".r2.dev",
    ".backblazeb2.com",
    ".digitaloceanspaces.com",
)
REGIONAL_S3_HOST = re.compile(r"^s3[.-][a-z0-9-]+\.amazonaws\.com\Z", re.ASCII)
HTML_EXT_RE = re.compile(r"\.(?:html?|shtml|xhtml)\Z", re.IGNORECASE | re.ASCII)

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


def is_ip_host(host: str) -> bool:
    bare = host[1:-1] if (host.startswith("[") and host.endswith("]")) else host
    return bool(IP_V4_RE.match(bare)) or (":" in bare and bool(IPV6_CHARS_RE.match(bare)))


def _is_valid_domain(domain: str) -> bool:
    return len(domain) <= 253 and bool(DOMAIN_RE.match(domain))


def _normalize_http_url(url: str) -> str:
    s = url.strip()
    if len(s) >= 7 and s[:8].lower().startswith(("http://", "https://")):
        q = min((i for i in (s.find("?"), s.find("#")) if i != -1), default=len(s))
        s = s[:q].replace("\\", "/") + s[q:]
    return s


def _to_ascii_hostname(raw_host: str) -> str:
    host = raw_host.lower().removesuffix(".")
    if not host:
        return ""
    if ":" in host:
        try:
            return str(ipaddress.IPv6Address(host)).lower()
        except ValueError:
            return host
    if host.isdigit():
        n = int(host)
        if 0 <= n <= 0xFFFFFFFF:
            return str(ipaddress.IPv4Address(n))
    if not host.isascii():
        try:
            labels = [lbl.encode("idna").decode("ascii") if lbl else "" for lbl in host.split(".")]
            return ".".join(labels).lower()
        except UnicodeError:
            return ""
    return host


def _parse_http(url: str) -> tuple[str, str] | None:
    try:
        p = urlsplit(_normalize_http_url(url))
        if p.scheme not in ("http", "https"):
            return None
        _ = p.port  # Validates numeric port 0..65535 like WHATWG URL
        raw_host = p.hostname
        if not raw_host:
            return None
        host = _to_ascii_hostname(raw_host)
        if not host:
            return None
        return host, p.path or "/"
    except ValueError:
        return None


def _host(url: str) -> str:
    parsed = _parse_http(url)
    return parsed[0] if parsed else ""


def _registrable(host: str) -> str:
    cleaned = host.lower().strip("[]").removesuffix(".")
    if not cleaned or is_ip_host(cleaned):
        return cleaned
    parts = [p for p in cleaned.split(".") if p]
    if len(parts) <= 2:
        return ".".join(parts)
    n = 3 if ".".join(parts[-2:]) in MULTI_SUFFIXES else 2
    return ".".join(parts[-n:])


def _is_cloud_storage_host(host: str) -> bool:
    return (
        host in CLOUD_STORAGE_HOSTS
        or bool(REGIONAL_S3_HOST.match(host))
        or any(host.endswith(s) for s in CLOUD_STORAGE_SUFFIXES)
    )


def is_cloud_html_link(url: str) -> bool:
    """True when a link points to an HTML page hosted directly on raw cloud object storage."""
    parsed = _parse_http(url)
    if not parsed:
        return False
    host, raw_path = parsed
    if not _is_cloud_storage_host(host):
        return False
    path = unquote(raw_path)
    return not path.endswith("\n") and bool(HTML_EXT_RE.search(path))


def shown_host(text: str) -> str:
    """Extract a hostname only when link text looks like an explicit URL or bare domain/IP."""
    t = text.strip()
    if not t:
        return ""
    m = EXPLICIT_URL.search(t)
    if m:
        candidate = re.sub(r"[.,;:!?]+\Z", "", m.group(0))
        h = _host(candidate)
        return h if (_is_valid_domain(h) or is_ip_host(h)) else ""
    if re.search(r"\s", t):
        return ""
    authority = re.split(r"[/?#]", t, maxsplit=1)[0]
    if "@" in authority or "://" in authority or authority.endswith("."):
        return ""
    ipv6_m = BRACKETED_IPV6_RE.match(authority)
    if ipv6_m:
        v6 = ipv6_m.group(1).lower()
        if is_ip_host(v6):
            return v6
    raw_host = PORT_SUFFIX_RE.sub("", authority).lower()
    if is_ip_host(raw_host):
        return raw_host
    if not _is_valid_domain(raw_host):
        return ""
    tld = raw_host.rsplit(".", 1)[-1]
    return raw_host if (raw_host.startswith("www.") or tld in COMMON_TLDS) else ""


def _sender_domain(sender: str) -> str:
    cleaned = sender.strip().rstrip(">").strip()
    if "@" not in cleaned:
        return ""
    return cleaned.rsplit("@", 1)[-1].lower().removesuffix(".")


def extract_features(sender: str, body: str, links: list[Link]) -> dict[str, float]:
    lower = body.lower()
    sender_reg = _registrable(_sender_domain(sender))
    mismatch = 0
    ip_links = 0
    punycode = 0
    cloud_html = 0
    shortener_links = 0
    ip_logger_links = 0
    external = 0
    for link in links:
        h = _host(link.href)
        reg = _registrable(h)
        if is_ip_host(h):
            ip_links += 1
        if "xn--" in h:
            punycode += 1
        if is_cloud_html_link(link.href):
            cloud_html += 1
        if h in IP_LOGGER_HOSTS or reg in IP_LOGGER_HOSTS:
            ip_logger_links += 1
        elif h in SHORTENER_HOSTS or reg in SHORTENER_HOSTS:
            shortener_links += 1
        shown = shown_host(link.text)
        if shown and h and _registrable(shown) != reg:
            mismatch += 1
        if sender_reg and reg and reg != sender_reg:
            external += 1
    return {
        "n_links": float(len(links)),
        "n_text_href_mismatch": float(mismatch),
        "n_ip_links": float(ip_links),
        "n_punycode_links": float(punycode),
        "n_cloud_html_links": float(cloud_html),
        "n_shortener_links": float(shortener_links),
        "n_iplogger_links": float(ip_logger_links),
        "n_external_links": float(external),
        "urgency_hits": float(sum(lower.count(w) for w in URGENCY)),
        "body_len": float(len(body)),
    }


FEATURE_NAMES = list(extract_features("", "", []).keys())
