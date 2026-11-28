import json
from pathlib import Path

import pytest

from phishml.features import FEATURE_NAMES, Link, extract_features, is_cloud_html_link, shown_host

PARITY_PATH = Path(__file__).parent / "fixtures" / "parity.json"
PARITY_CASES = json.loads(PARITY_PATH.read_text(encoding="utf-8"))
# The order is the index of each weight in the exported model (shared with extension/src/features.test.ts).
FEATURE_NAMES_PATH = Path(__file__).parent / "fixtures" / "feature_names.json"


def test_feature_order_matches_the_shared_fixture():
    assert FEATURE_NAMES == json.loads(FEATURE_NAMES_PATH.read_text(encoding="utf-8"))
    assert list(extract_features("a@b.example", "x", [Link("t", "https://c.example/")])) == FEATURE_NAMES


def test_parity_fixture_count_and_schema():
    assert len(PARITY_CASES) >= 20
    for case in PARITY_CASES:
        assert list(case["expected"].keys()) == FEATURE_NAMES, case["name"]


@pytest.mark.parametrize("case", PARITY_CASES, ids=[c["name"] for c in PARITY_CASES])
def test_parity_fixture_vectors(case):
    links = [Link(text=item["text"], href=item["href"]) for item in case["links"]]
    assert extract_features(case["sender"], case["body"], links) == case["expected"]


def test_mismatched_link_text_is_flagged():
    f = extract_features("a@bank.com", "hi", [Link("www.bank.com/login", "https://evil.example/login")])
    assert f["n_text_href_mismatch"] == 1


def test_matching_link_not_flagged():
    f = extract_features("a@bank.com", "hi", [Link("www.bank.com", "https://www.bank.com/x")])
    assert f["n_text_href_mismatch"] == 0


def test_ip_and_punycode_and_urgency():
    f = extract_features("a@x.com", "URGENT: verify now", [Link("click", "http://1.2.3.4/a"), Link("x", "https://xn--pple-43d.com")])
    assert f["n_ip_links"] == 1 and f["n_punycode_links"] == 1 and f["urgency_hits"] == 2


def test_ignores_prose_filenames_and_emails_in_link_text():
    for text in ("please reset your password immediately.", "report.pdf", "Node.js", "support@mongodb.com"):
        assert shown_host(text) == ""
        f = extract_features("cloud-manager-support@mongodb.com", text, [Link(text, "https://account.mongodb.com/reset")])
        assert f["n_text_href_mismatch"] == 0


def test_extracts_embedded_urls_and_handles_multipart_suffixes():
    assert shown_host("Visit https://www.paypal.com/login.") == "www.paypal.com"
    mismatch = extract_features("a@barclays.co.uk", "hi", [Link("www.barclays.co.uk/login", "https://evil.co.uk/login")])
    assert mismatch["n_text_href_mismatch"] == 1
    same_org = extract_features("a@barclays.co.uk", "hi", [Link("www.barclays.co.uk/login", "https://online.barclays.co.uk/x")])
    assert same_org["n_text_href_mismatch"] == 0


def test_cloud_storage_html_links_and_billing_urgency():
    assert is_cloud_html_link("https://storage.googleapis.com/example-lure-bucket/lure.html#?act=cl")
    assert is_cloud_html_link("https://bucket.s3.amazonaws.com/login.htm")
    assert is_cloud_html_link("https://acct.blob.core.windows.net/c/verify.html")
    assert is_cloud_html_link("https://firebasestorage.googleapis.com/v0/b/x/o/a%2Flogin.html?alt=media")
    assert is_cloud_html_link("https://pub-1.r2.dev/a.html")
    assert not is_cloud_html_link("https://storage.googleapis.com/assets/logo.png")
    assert not is_cloud_html_link("https://bucket.s3.amazonaws.com/invoice.pdf")
    assert not is_cloud_html_link("https://account.mongodb.com/login.html")

    f = extract_features(
        "alert-0000@lure-sender.example",
        "Your photos will be deleted. Update billing details before expiration.",
        [
            Link("Review billing", "https://storage.googleapis.com/example-lure-bucket/lure.html#?act=cl"),
            Link("Logo", "https://storage.googleapis.com/assets/logo.png"),
        ],
    )
    assert f["n_cloud_html_links"] == 1
    assert f["urgency_hits"] >= 3


def test_lookalike_letter_in_shown_tld_mismatches():
    href = "https://login-check.example-evil.xyz/s"
    for text in ("www.paypal.cоm", "https://www.paypal.cоm/signin", "appleid.apple.сom", "paypal.cоm"):
        assert shown_host(text).rsplit(".", 1)[-1].startswith("xn--"), text
        assert extract_features("x@sender.example", "Hello", [Link(text, href)])["n_text_href_mismatch"] == 1, text
    assert shown_host("https://пример.рф/") == "xn--e1afmkfd.xn--p1ai"
    assert shown_host("Нажмите.здесь") == ""


def test_urgency_words_with_lookalike_letters_are_counted():
    body = "Your pаssword expirеd. Vеrify immеdiately or your mailbox will be suspеnded."
    assert extract_features("it@corp.example", body, [])["urgency_hits"] == 5
    russian = "Срочно смените пароль"
    assert extract_features("a@b.example", russian, [])["urgency_hits"] == 0
