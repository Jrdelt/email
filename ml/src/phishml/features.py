"""Email feature extraction. Mirror of extension/src/features.ts — keep in sync (parity-tested)."""
from __future__ import annotations

import ipaddress
import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import unquote

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
    "j.mp", "qrco.de", "bit.do", "tr.im", "x.co", "shorturl.asia", "tiny.one", "u.to",
})
IP_V4_RE = re.compile(r"^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\Z", re.ASCII)
IPV6_CHARS_RE = re.compile(r"^[0-9a-f:.]+\Z", re.IGNORECASE | re.ASCII)
BRACKETED_IPV6_RE = re.compile(r"^\[([0-9a-f:.]+)\](?::\d{1,5})?\Z", re.IGNORECASE | re.ASCII)
PORT_SUFFIX_RE = re.compile(r":\d{1,5}\Z", re.ASCII)
# JavaScript's whitespace set (String.prototype.trim and regex \s), so trimming and URL-in-text matching behave
# exactly like features.ts. Python's own str.strip()/\s differ (they include U+001C-U+001F and U+0085, not U+FEFF).
JS_WS = "\t\n\x0b\x0c\r \xa0\u1680" + "".join(chr(c) for c in range(0x2000, 0x200B)) + "\u2028\u2029\u202f\u205f\u3000\ufeff"
JS_WS_RE = re.compile("[" + re.escape(JS_WS) + "]")
EXPLICIT_URL = re.compile("https?://[^" + re.escape(JS_WS) + "<>\"'()]+", re.IGNORECASE)
# WHATWG URL parsing trims only C0 controls and space from both ends of an href.
C0_OR_SPACE = "".join(chr(c) for c in range(0x21))
DOMAIN_RE = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z", re.ASCII)

CLOUD_STORAGE_HOSTS = frozenset({
    "storage.googleapis.com",
    "commondatastorage.googleapis.com",
    "storage.cloud.google.com",
    "firebasestorage.googleapis.com",
    "ipfs.io",
    "dweb.link",
    "w3s.link",
    "nftstorage.link",
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
    ".storage.googleapis.com",
    ".web.core.windows.net",
    ".ipfs.dweb.link",
    ".ipfs.w3s.link",
    ".ipfs.nftstorage.link",
)
REGIONAL_S3_HOST = re.compile(r"^s3[.-][a-z0-9-]+\.amazonaws\.com\Z", re.ASCII)
VIRTUAL_REGIONAL_S3_HOST = re.compile(r"\.s3[.-](?:website[.-])?(?:dualstack\.)?[a-z0-9-]+\.amazonaws\.com\Z", re.ASCII)
# Every Default_Ignorable_Code_Point plus interlinear annotation controls (mirror of features.ts INVISIBLE_RE;
# spelled out so it cannot drift with the Unicode version of the runtime).
INVISIBLE_RE = re.compile(
    "[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f"
    "\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]"
)
DOT_LOOKALIKE_RE = re.compile("[\u0660\u06f0\u0701\u0702\u3002\ua4f8\uff0e\uff61]")
# Letters that NFKC keeps but that look Latin (mirror of features.ts CONFUSABLE_LATIN; spelled out, no \p classes).
CONFUSABLE_LATIN = {
    # Cyrillic lower case
    "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x",
    "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u0501": "d", "\u04bb": "h", "\u04cf": "l", "\u051b": "q",
    "\u051d": "w",
    # Cyrillic upper case
    "\u0410": "A", "\u0412": "B", "\u0415": "E", "\u041a": "K", "\u041c": "M", "\u041d": "H", "\u041e": "O",
    "\u0420": "P", "\u0421": "C", "\u0422": "T", "\u0425": "X", "\u0406": "I", "\u0408": "J", "\u0405": "S",
    # Greek lower case
    "\u03bf": "o", "\u03b1": "a", "\u03bd": "v", "\u03c1": "p", "\u03c4": "t", "\u03b9": "i", "\u03ba": "k",
    "\u03c5": "u",
    # Greek upper case
    "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H", "\u0399": "I", "\u039a": "K",
    "\u039c": "M", "\u039d": "N", "\u039f": "O", "\u03a1": "P", "\u03a4": "T", "\u03a5": "Y", "\u03a7": "X",
    # Latin IPA / dotless and Armenian
    "\u0131": "i", "\u0251": "a", "\u0261": "g", "\u0585": "o",
}
CONFUSABLE_RE = re.compile("[" + "".join(CONFUSABLE_LATIN) + "]")
ASCII_LETTER_RE = re.compile("[A-Za-z]")
JS_NON_WS_RUN_RE = re.compile("[^" + re.escape(JS_WS) + "]+")  # JavaScript's \S+


def _fold_word(m: re.Match[str]) -> str:
    w = m.group(0)
    if ASCII_LETTER_RE.search(w) and CONFUSABLE_RE.search(w):
        return CONFUSABLE_RE.sub(lambda c: CONFUSABLE_LATIN[c.group(0)], w)
    return w


def _fold_mixed_script_words(text: str) -> str:
    """Fold look-alike letters only inside words that mix them with ASCII letters (mirror of features.ts)."""
    return JS_NON_WS_RUN_RE.sub(_fold_word, text)
# Quotes/parentheses around a bare domain and sentence punctuation after it (mirror of WRAP_OPEN/WRAP_CLOSE).
WRAP_OPEN = "\"'(<{\u00ab\u201c\u2018"  # not "[": bracketed IPv6 literals
WRAP_CLOSE = "\"')>}\u00bb\u201d\u2019.,;:!?"
MAX_SHOWN_AUTHORITY = 300  # longer than any real host plus port; never sent through IDNA


def _js_len(s: str) -> int:
    """String length in UTF-16 code units, as JavaScript's .length counts it."""
    return len(s.encode("utf-16-le", "surrogatepass")) // 2
HTML_EXT_RE = re.compile(r"\.(?:html?|shtml|xhtml|xht)\Z", re.IGNORECASE | re.ASCII)

MULTI_SUFFIXES = frozenset({
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au",
    "co.nz", "co.jp", "ne.jp", "or.jp", "com.br", "com.cn", "com.mx", "co.in", "co.za", "com.sg",
    "com.tr", "co.kr", "com.hk", "com.tw", "com.ar", "co.id", "com.my", "com.ph", "com.vn",
})

# Generic second-level labels under 2-letter country TLDs and CentralNic-style suffixes (mirror of domain.ts).
GENERIC_SLDS = frozenset({
    "com", "net", "org", "co", "gov", "edu", "ac", "or", "ne", "go", "gob", "mil", "nic", "ltd", "plc", "sch", "nom",
    "info", "biz",
})
EXTRA_SUFFIXES = frozenset({
    "us.com", "uk.com", "eu.com", "ru.com", "sa.com", "za.com", "br.com", "cn.com", "de.com", "jpn.com", "gb.net", "uk.net",
})


def _is_multi_part_suffix(two_labels: str) -> bool:
    sld, _, tld = two_labels.partition(".")
    if not sld or not tld or "." in tld:
        return False
    return two_labels in MULTI_SUFFIXES or two_labels in EXTRA_SUFFIXES or (len(tld) == 2 and sld in GENERIC_SLDS)


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


_HTTP_SCHEME_RE = re.compile(r"(https?):", re.IGNORECASE)


def _normalize_http_url(url: str) -> str:
    """Rewrite an http(s) URL the way WHATWG parses it, so _parse_http sees the same host as `new URL()`.

    WHATWG removes tabs/newlines anywhere, ignores any mix of '/' and '\\' (or none) after a special scheme
    ("http:evil.com", "https:\\\\evil.com", "http:///evil.com" all have host evil.com) and treats '\\' as '/'
    before the query or fragment.
    """
    s = url.strip(C0_OR_SPACE).replace("\t", "").replace("\n", "").replace("\r", "")
    m = _HTTP_SCHEME_RE.match(s)
    if m:
        rest = s[m.end() :].lstrip("/\\")
        q = min((i for i in (rest.find("?"), rest.find("#")) if i != -1), default=len(rest))
        s = f"{m.group(1).lower()}://{rest[:q].replace(chr(92), '/')}{rest[q:]}"
    return s


# WHATWG forbidden domain code points: a host containing one is not a valid URL host at all.
FORBIDDEN_DOMAIN_CHARS = frozenset("\x00\t\n\r #/:<>?@[\\]^|%\x7f") | frozenset(chr(c) for c in range(0x20))
_DIGITS = {10: frozenset("0123456789"), 8: frozenset("01234567"), 16: frozenset("0123456789abcdefABCDEF")}


def _ends_in_number(host: str) -> bool:
    """WHATWG "ends in a number": the last label (ignoring one trailing dot) is decimal or 0x-hex."""
    parts = host.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts = parts[:-1]
    last = parts[-1]
    if last and all(c in _DIGITS[10] for c in last):
        return True
    return last[:2] in ("0x", "0X") and all(c in _DIGITS[16] for c in last[2:])


def _whatwg_ipv4(host: str) -> str:
    """WHATWG IPv4 parser (hex, octal and short forms such as 0x7f.1 or 127.1). Raises ValueError if invalid."""
    parts = host.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts = parts[:-1]
    if len(parts) > 4:
        raise ValueError("too many IPv4 parts")
    numbers = []
    for part in parts:
        if part == "":
            raise ValueError("empty IPv4 part")
        radix = 10
        if part[:2] in ("0x", "0X"):
            radix, part = 16, part[2:]
        elif len(part) >= 2 and part[0] == "0":
            radix, part = 8, part[1:]
        if part and any(c not in _DIGITS[radix] for c in part):
            raise ValueError("bad IPv4 digit")
        numbers.append(int(part, radix) if part else 0)
    if any(n > 255 for n in numbers[:-1]) or numbers[-1] >= 256 ** (5 - len(numbers)):
        raise ValueError("IPv4 part out of range")
    value = numbers[-1] + sum(n * 256 ** (3 - i) for i, n in enumerate(numbers[:-1]))
    return str(ipaddress.IPv4Address(value))


# UTS46 ToASCII as WHATWG URL runs it: non-transitional, CheckBidi and CheckJoiners on, no STD3 rules, no DNS
# length limit. Built on the interpreter's Unicode database (NFKC + full case folding) instead of the stdlib
# "idna" codec, which implements IDNA 2003: Unicode 3.2 nameprep tables (regenerated between patch releases),
# RFC 3454 bidi (rejects "دبي2020"), a 63-character label limit, and no ContextJ rules.
# Deviation characters are kept (IDNA 2003 turns faß.de into fass.de; browsers produce xn--fa-hia.de).
_DEVIATIONS = frozenset("\u00df\u03c2\u200c\u200d")
# Code points UTS46 maps to nothing (spelled out; the other default-ignorables are disallowed).
_UTS46_IGNORED = frozenset(
    "\u00ad\u034f\u180b\u180c\u180d\u180f\u200b\u2060\u2064\ufeff"
    + "".join(chr(c) for c in range(0xFE00, 0xFE10))
    + "".join(chr(c) for c in range(0x1BCA0, 0x1BCA4))
    + "".join(chr(c) for c in range(0xE0100, 0xE01F0))
)
_UTS46_DISALLOWED_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Cn", "Zs", "Zl", "Zp"})
# Assigned code points UTS46 disallows although NFKC + case folding would map them to valid text: Hangul and Khmer
# fillers, Asomtavruli and other capitals kept for IDNA 2003 stability, ideographic description characters, a few
# CJK compatibility ideographs, the object/replacement characters.
_UTS46_DISALLOWED = frozenset(
    "\u04c0\u1680\u17b4\u17b5\u1806\u2132\u2183\u115f\u1160\u3164\u31ef\uffa0\ufffc\ufffd"
    "\U0002f868\U0002f874\U0002f91f\U0002f95f\U0002f9bf"
    + "".join(chr(c) for c in range(0x10A0, 0x10C6))
    + "".join(chr(c) for c in range(0x2FF0, 0x3000))
)
# Full stops UTS46 maps to "."; any other character whose compatibility form contains a dot ("⒈", "…", "㏂") is
# disallowed rather than split into labels.
_UTS46_DOTS = frozenset("\u3002\uff0e\uff61")
_ZWNJ, _ZWJ = "\u200c", "\u200d"
_RTL_ALLOWED = frozenset({"R", "AL", "AN", "EN", "ES", "CS", "ET", "ON", "BN", "NSM"})
_LTR_ALLOWED = frozenset({"L", "EN", "ES", "CS", "ET", "ON", "BN", "NSM"})
_map_cache: dict[str, str | None] = {}
_MISSING = object()


def _uts46_map_char(c: str) -> str | None:
    """UTS46 mapping of one code point ("" when it is ignored, None when it is disallowed)."""
    hit = _map_cache.get(c, _MISSING)
    if hit is not _MISSING:
        return hit  # type: ignore[return-value]
    if c in _DEVIATIONS or c.isascii():
        mapped: str | None = c.lower()
    elif c in _UTS46_IGNORED:
        mapped = ""
    elif c in _UTS46_DISALLOWED or unicodedata.category(c) in _UTS46_DISALLOWED_CATEGORIES:
        mapped = None
    elif c in _UTS46_DOTS:
        mapped = "."
    else:
        m = unicodedata.normalize("NFKC", c)
        for _ in range(4):  # NFKC_Casefold: case folding and NFKC until stable
            n = unicodedata.normalize("NFKC", m.casefold())
            if n == m:
                break
            m = n
        mapped = None if ("." in m or "\u3002" in m) else m
    if len(_map_cache) < 65536:
        _map_cache[c] = mapped
    return mapped


def _uts46_char_valid(c: str) -> bool:
    """A code point that may appear in a mapped label as it is (UTS46 status valid or deviation)."""
    return c in _DEVIATIONS or (c != "." and _uts46_map_char(c) == c)


# Arabic letters that join only to the right (Joining_Type R), and the non-joining hamzas; every other Arabic
# letter joins on both sides (D). Spelled out because the stdlib has no Joining_Type data. Used for the ZWNJ rule.
_ARABIC_RIGHT_JOINING = frozenset(
    "\u0622\u0623\u0624\u0625\u0627\u0629\u062f\u0630\u0631\u0632\u0648\u0671\u0672\u0673\u0675\u0676\u0677"
    + "".join(chr(c) for c in range(0x0688, 0x069A))
    + "\u06c0\u06c3\u06c4\u06c5\u06c6\u06c7\u06c8\u06c9\u06ca\u06cb\u06cd\u06cf\u06d2\u06d3\u06d5\u06ee\u06ef"
    + "\u0759\u075a\u075b\u076b\u076c\u0771\u0773\u0774\u0778\u0779"
)
_ARABIC_NON_JOINING = frozenset("\u0621\u0674\u06fd\u06fe")


def _arabic_letter(c: str) -> bool:
    o = ord(c)
    return (0x0620 <= o <= 0x06FF or 0x0750 <= o <= 0x077F) and unicodedata.category(c) == "Lo"


def _joins_left_side(c: str) -> bool:  # Joining_Type L or D
    return _arabic_letter(c) and c not in _ARABIC_RIGHT_JOINING and c not in _ARABIC_NON_JOINING


def _joins_right_side(c: str) -> bool:  # Joining_Type R or D
    return _arabic_letter(c) and c not in _ARABIC_NON_JOINING


def _bidi_ok(label: str) -> bool:
    """RFC 5893 bidi rule as WHATWG URL (ada, Node) applies it: per label, to labels with R, AL or AN characters.

    A label whose first character is L may not contain right-to-left or Arabic-number characters before its last
    character; any other such label is a right-to-left label (rules 2-4). Labels without R/AL/AN are not checked.
    """
    classes = [unicodedata.bidirectional(c) for c in label]
    if not any(b in ("R", "AL", "AN") for b in classes):
        return True
    last = len(classes) - 1
    while last >= 0 and classes[last] == "NSM":
        last -= 1
    if last < 0:
        return False
    if classes[0] == "L":
        return all(b in _LTR_ALLOWED for b in classes[:last])
    return (
        all(b in _RTL_ALLOWED for b in classes[:last])
        and classes[last] in ("R", "AL", "EN", "AN")
        and not ("EN" in classes and "AN" in classes)
    )


def _label_valid(label: str) -> bool:
    """UTS46 validity of one mapped label (NFC, no leading mark, valid code points, ContextJ, bidi)."""
    if not label or label.isascii():
        return True
    if not unicodedata.is_normalized("NFC", label) or unicodedata.category(label[0]).startswith("M"):
        return False
    if not all(_uts46_char_valid(c) for c in label):
        return False
    # ContextJ (RFC 5892 A.1/A.2) as ada applies it: a joiner after a virama makes the label valid; otherwise a ZWNJ
    # needs a left- or dual-joining letter somewhere before it and a right- or dual-joining one after it.
    for i, c in enumerate(label):
        if c in (_ZWNJ, _ZWJ):
            if i > 0 and unicodedata.combining(label[i - 1]) == 9:
                return True
            if c == _ZWJ or i + 1 >= len(label):
                return False
            return any(_joins_left_side(x) for x in label[:i]) and any(_joins_right_side(x) for x in label[i + 1 :])
    return _bidi_ok(label)


def _domain_to_ascii(host: str) -> str:
    """UTS46 ToASCII of a (percent-decoded) host, or "" when it fails."""
    mapped = []
    for c in host:
        m = _uts46_map_char(c)
        if m is None:
            return ""
        mapped.append(m)
    out = []
    for label in unicodedata.normalize("NFC", "".join(mapped)).split("."):
        if label.startswith("xn--"):
            try:
                decoded = label[4:].encode("ascii").decode("punycode")
            except (UnicodeError, ValueError):
                return ""
            # A punycode label must decode to a non-empty, valid, already mapped label (rejects xn--zz, U+0080...);
            # it is then kept as written, like WHATWG URL does.
            if not decoded or not _label_valid(decoded):
                return ""
            if any(_uts46_map_char(c) != c for c in decoded if c not in _DEVIATIONS):
                return ""
            out.append(label)
        elif not _label_valid(label):
            return ""
        else:
            out.append(label if label.isascii() else "xn--" + label.encode("punycode").decode("ascii"))
    return ".".join(out)


def _label_to_ascii(label: str) -> str:
    """UTS46 ToASCII of one label, or "" when it fails."""
    return _domain_to_ascii(label) if label else ""


def _valid_punycode(label: str) -> bool:
    """WHATWG rejects hosts whose xn-- labels are not valid punycode (e.g. xn--zz.com)."""
    return _domain_to_ascii(label) == label


def _whatwg_ipv6(addr: ipaddress.IPv6Address) -> str:
    """Serialise like WHATWG: hex pieces only (never dotted IPv4), longest run of 2+ zero pieces as '::'."""
    pieces = [int.from_bytes(addr.packed[i : i + 2], "big") for i in range(0, 16, 2)]
    best_start, best_len, i = -1, 1, 0
    while i < 8:
        if pieces[i] == 0:
            j = i
            while j < 8 and pieces[j] == 0:
                j += 1
            if j - i > best_len:
                best_start, best_len = i, j - i
            i = j
        else:
            i += 1
    if best_start == -1:
        return ":".join(f"{p:x}" for p in pieces)
    head = ":".join(f"{p:x}" for p in pieces[:best_start])
    tail = ":".join(f"{p:x}" for p in pieces[best_start + best_len :])
    return f"{head}::{tail}"


_IPV6_LITERAL_RE = re.compile(r"[0-9a-f:.]+\Z", re.IGNORECASE | re.ASCII)


def _ipv6_literal(inner: str) -> str:
    """WHATWG IPv6 host (the text inside the brackets), serialised, or "" (no zone IDs, no IPvFuture)."""
    if not _IPV6_LITERAL_RE.match(inner):
        return ""
    try:
        return _whatwg_ipv6(ipaddress.IPv6Address(inner))
    except ValueError:
        return ""


def _to_ascii_hostname(raw_host: str) -> str:
    """Host as WHATWG URL serialises it (mirror of `new URL(...).hostname` used by features.ts), or "" if invalid."""
    if raw_host.startswith("["):
        return _ipv6_literal(raw_host[1:-1]) if raw_host.endswith("]") else ""
    host = unquote(raw_host)  # WHATWG percent-decodes the host first (ev%69l.com -> evil.com)
    if not host:
        return ""
    if "\ufffd" in host:  # invalid UTF-8 after percent-decoding
        return ""
    host = host.lower() if host.isascii() else _domain_to_ascii(host)
    # A ':' (also from %3A or a fullwidth colon) or bracket outside an IPv6 literal is a forbidden code point.
    if not host or any(c in FORBIDDEN_DOMAIN_CHARS for c in host):
        return ""
    if any(lbl.startswith("xn--") and not _valid_punycode(lbl) for lbl in host.split(".")):
        return ""
    if _ends_in_number(host):
        try:
            return _whatwg_ipv4(host)
        except ValueError:
            return ""
    return host.removesuffix(".")


_PORT_RE = re.compile(r"\d*\Z", re.ASCII)


def _parse_http(url: str) -> tuple[str, str] | None:
    """(host, path) of an http(s) URL as WHATWG parses it, or None.

    The authority is split by hand rather than with urlsplit: urlsplit runs its bracket and NFKC checks on the
    whole netloc, userinfo included, so "http://u[@evil.com/" or "http://a\uff1ab@evil.com/" failed although
    the host is evil.com.
    """
    s = _normalize_http_url(url)
    m = re.match(r"(https?)://", s)
    if not m:
        return None
    rest = s[m.end() :]
    end = min((i for i in (rest.find("/"), rest.find("?"), rest.find("#")) if i != -1), default=len(rest))
    authority, after = rest[:end], rest[end:]
    hostport = authority.rpartition("@")[2]  # userinfo is everything before the last '@'
    if hostport.startswith("["):
        close = hostport.find("]")
        if close == -1:
            return None
        raw_host, port = hostport[: close + 1], hostport[close + 1 :]
        if port and not port.startswith(":"):
            return None
        port = port[1:]
    else:
        raw_host, _, port = hostport.partition(":")
    if not _PORT_RE.match(port) or (port and int(port) > 65535):
        return None
    if not raw_host:
        return None
    host = _to_ascii_hostname(raw_host)
    if not host:
        return None
    path = after[: min((i for i in (after.find("?"), after.find("#")) if i != -1), default=len(after))]
    return host, path or "/"


def _host(url: str) -> str:
    parsed = _parse_http(url)
    return parsed[0] if parsed else ""


def _registrable(host: str) -> str:
    cleaned = host.lower()
    cleaned = cleaned[1:] if cleaned.startswith("[") else cleaned  # one bracket per end, like the TS regex
    cleaned = (cleaned[:-1] if cleaned.endswith("]") else cleaned).removesuffix(".")
    if not cleaned or is_ip_host(cleaned):
        return cleaned
    parts = [p for p in cleaned.split(".") if p]
    if len(parts) <= 2:
        return ".".join(parts)
    n = 3 if _is_multi_part_suffix(".".join(parts[-2:])) else 2
    return ".".join(parts[-n:])


def _is_cloud_storage_host(host: str) -> bool:
    return (
        host in CLOUD_STORAGE_HOSTS
        or bool(REGIONAL_S3_HOST.match(host))
        or bool(VIRTUAL_REGIONAL_S3_HOST.search(host))
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


def _normalize_shown_text(text: str) -> str:
    """Normalise link text the way a reader sees it (mirror of features.ts normalizeShownText)."""
    return DOT_LOOKALIKE_RE.sub(".", INVISIBLE_RE.sub("", unicodedata.normalize("NFKC", text)))


# A host whose TLD is punycode ('www.paypal.cоm' -> 'www.paypal.xn--cm-...'), which _is_valid_domain rejects
# (mirror of features.ts PUNY_TLD_HOST_RE; local to shown_host).
PUNY_TLD_HOST_RE = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+xn--[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?\Z", re.ASCII)


def _is_puny_tld_host(h: str) -> bool:
    return len(h) <= 253 and bool(PUNY_TLD_HOST_RE.match(h))


def shown_host(text: str) -> str:
    """Extract a hostname only when link text looks like an explicit URL or bare domain/IP."""
    t = _normalize_shown_text(text).strip(JS_WS)
    if not t:
        return ""
    m = EXPLICIT_URL.search(t)
    if m:
        candidate = m.group(0).rstrip(".,;:!?")  # linear; same result as the TS trimTrailingPunct
        if _js_len(re.split(r"[/?#\\]", candidate[candidate.index("://") + 3 :], maxsplit=1)[0]) > MAX_SHOWN_AUTHORITY:
            return ""
        h = _host(candidate)
        return h if (_is_valid_domain(h) or is_ip_host(h) or _is_puny_tld_host(h)) else ""
    bare = t.lstrip(WRAP_OPEN).rstrip(WRAP_CLOSE)
    if not bare or JS_WS_RE.search(bare):
        return ""
    authority = re.split(r"[/?#]", bare, maxsplit=1)[0]
    if _js_len(authority) > MAX_SHOWN_AUTHORITY:
        return ""
    if "@" in authority or "://" in authority or authority.endswith("."):
        return ""
    ipv6_m = BRACKETED_IPV6_RE.match(authority)
    if ipv6_m:
        v6 = ipv6_m.group(1).lower()
        if is_ip_host(v6):
            return v6
    raw_host = PORT_SUFFIX_RE.sub("", authority).lower()
    if not raw_host.isascii():
        raw_host = _to_ascii_hostname(raw_host)
    if is_ip_host(raw_host):
        return raw_host
    if _is_puny_tld_host(raw_host):  # non-ASCII TLD after an ASCII label; all-non-ASCII bare text stays prose
        return raw_host if any(not lbl.startswith("xn--") for lbl in raw_host.split(".")[:-1]) else ""
    if not _is_valid_domain(raw_host):
        return ""
    tld = raw_host.rsplit(".", 1)[-1]
    return raw_host if (raw_host.startswith("www.") or tld in COMMON_TLDS) else ""


def _sender_domain(sender: str) -> str:
    cleaned = sender.strip(JS_WS).rstrip(">").strip(JS_WS)
    if "@" not in cleaned:
        return ""
    return cleaned.rsplit("@", 1)[-1].lower().removesuffix(".")


def extract_features(sender: str, body: str, links: list[Link]) -> dict[str, float]:
    lower = _fold_mixed_script_words(body).lower()
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
