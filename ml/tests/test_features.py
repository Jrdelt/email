from phishml.features import Link, extract_features


def test_mismatched_link_text_is_flagged():
    f = extract_features("a@bank.com", "hi", [Link("www.bank.com/login", "https://evil.example/login")])
    assert f["n_text_href_mismatch"] == 1


def test_matching_link_not_flagged():
    f = extract_features("a@bank.com", "hi", [Link("www.bank.com", "https://www.bank.com/x")])
    assert f["n_text_href_mismatch"] == 0


def test_ip_and_punycode_and_urgency():
    f = extract_features("a@x.com", "URGENT: verify now", [Link("click", "http://1.2.3.4/a"), Link("x", "https://xn--pple-43d.com")])
    assert f["n_ip_links"] == 1 and f["n_punycode_links"] == 1 and f["urgency_hits"] == 2
