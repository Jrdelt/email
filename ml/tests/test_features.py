from phishml.features import Link, extract_features, shown_host


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
