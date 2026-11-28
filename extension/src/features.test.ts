import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractFeatures, FEATURE_NAMES, isCloudHtmlLink, type Link, scoreEmail, shownHost } from './features';

interface ParityCase {
  name: string;
  sender: string;
  body: string;
  links: Link[];
  expected: Record<string, number>;
}

const PARITY_CASES = JSON.parse(
  readFileSync(new URL('../../ml/tests/fixtures/parity.json', import.meta.url), 'utf8'),
) as ParityCase[];

describe('parity.json contract (TS <-> Python)', () => {
  it('contains at least 20 cross-language parity cases covering all FEATURE_NAMES', () => {
    expect(PARITY_CASES.length).toBeGreaterThanOrEqual(20);
    for (const c of PARITY_CASES) {
      expect(Object.keys(c.expected).sort()).toEqual([...FEATURE_NAMES].sort());
    }
  });

  it.each(PARITY_CASES)('matches expected features for $name', ({ sender, body, links, expected }) => {
    expect(extractFeatures(sender, body, links)).toEqual(expected);
  });
});

describe('shownHost', () => {
  it.each([
    'please reset your password immediately.',
    'Click here.',
    'Learn more...',
    'Reset.',
    'Dr.Smith',
    'report.pdf',
    'Node.js',
    'script.py',
    'v2.1',
    '$19.99',
    'support@mongodb.com',
  ])('ignores prose, filenames, and email addresses: %j', (text) => {
    expect(shownHost(text)).toBe('');
  });

  it.each([
    ['www.bank.com/login', 'www.bank.com'],
    ['https://www.paypal.com/verify', 'www.paypal.com'],
    ['Visit https://www.paypal.com/login.', 'www.paypal.com'],
    ['paypal.com', 'paypal.com'],
    ['1.2.3.4/login', '1.2.3.4'],
    ['www.barclays.co.uk/login', 'www.barclays.co.uk'],
  ])('extracts host from %j -> %s', (text, expected) => {
    expect(shownHost(text)).toBe(expected);
  });
});

describe('scoreEmail', () => {
  it('flags link text/href mismatch', () => {
    const v = scoreEmail('a@bank.com', 'hi', [{ text: 'www.bank.com/login', href: 'https://evil.example/login' }]);
    expect(v.level).not.toBe('safe');
  });
  it('passes a clean email', () => {
    expect(scoreEmail('a@bank.com', 'lunch?', [{ text: 'www.bank.com', href: 'https://www.bank.com/x' }]).level).toBe('safe');
  });
  it('does not false-positive on legitimate MongoDB password reset prose link', () => {
    const v = scoreEmail(
      'cloud-manager-support@mongodb.com',
      "If you didn't request this, please reset your password immediately.",
      [{ text: 'please reset your password immediately.', href: 'https://account.mongodb.com/account/reset' }],
    );
    expect(v.level).toBe('safe');
    expect(v.reasons.some((r) => r.includes('A link says'))).toBe(false);
  });
  it('handles multi-part suffixes accurately', () => {
    const mismatch = scoreEmail('a@barclays.co.uk', 'hi', [{ text: 'www.barclays.co.uk/login', href: 'https://evil.co.uk/login' }]);
    expect(mismatch.level).not.toBe('safe');
    const sameOrg = scoreEmail('a@barclays.co.uk', 'hi', [{ text: 'www.barclays.co.uk/login', href: 'https://online.barclays.co.uk/x' }]);
    expect(sameOrg.level).toBe('safe');
  });
  it('flags cloud-storage HTML lure links while ignoring cloud-hosted images/PDFs', () => {
    expect(isCloudHtmlLink('https://storage.googleapis.com/example-lure-bucket/lure.html#?act=cl')).toBe(true);
    expect(isCloudHtmlLink('https://bucket.s3.amazonaws.com/login.htm')).toBe(true);
    expect(isCloudHtmlLink('https://acct.blob.core.windows.net/c/verify.html')).toBe(true);
    expect(isCloudHtmlLink('https://firebasestorage.googleapis.com/v0/b/x/o/a%2Flogin.html?alt=media')).toBe(true);
    expect(isCloudHtmlLink('https://pub-1.r2.dev/a.html')).toBe(true);

    expect(isCloudHtmlLink('https://storage.googleapis.com/assets/logo.png')).toBe(false);
    expect(isCloudHtmlLink('https://bucket.s3.amazonaws.com/invoice.pdf')).toBe(false);
    expect(isCloudHtmlLink('https://account.mongodb.com/login.html')).toBe(false);

    const phish = scoreEmail(
      'alert-0000@lure-sender.example',
      "We've Blocked Your Account! Your photos and videos will be deleted. Please update your billing details. Expiration date: Today.",
      [
        { text: 'Cloud Review billing', href: 'https://storage.googleapis.com/example-lure-bucket/lure.html#?act=cl' },
        { text: 'Review billing', href: 'https://storage.googleapis.com/example-lure-bucket/lure.html#?act=cl' },
        { text: 'Unsubscribe', href: 'https://storage.googleapis.com/example-lure-bucket/lure.html#?act=un' },
        { text: 'here', href: 'https://storage.googleapis.com/example-lure-bucket/lure.html#?act=oop' },
      ],
    );
    expect(phish.level).toBe('likely-phishing');
    expect(phish.reasons).toContain('A link points to a web page hosted on raw cloud storage');
  });

  it('flags Grabify / IP-logger phishing links (urlto.me) and urgent unknown short-code links', () => {
    const grabify = scoreEmail(
      '',
      'We detected unusual activity on your account and temporarily limited access.\nPlease verify your details within 24 hours to avoid interruption.',
      [{ text: 'Verify Now', href: 'https://urlto.me/2r7Nf' }],
    );
    expect(grabify.level).toBe('likely-phishing');
    expect(grabify.score).toBeGreaterThanOrEqual(0.6);
    expect(grabify.reasons.join(' ')).toContain('urlto.me');

    const rotatingTracker = scoreEmail(
      'security@other-vendor.example',
      'We detected unusual activity on your account and temporarily limited access. Please verify your details within 24 hours to avoid interruption.',
      [{ text: 'Verify Now', href: 'https://fresh-rotator.example/2r7Nf' }],
    );
    expect(rotatingTracker.level).toBe('suspicious');
    expect(rotatingTracker.reasons.join(' ')).toContain('high-pressure');

    const marketingShortLink = scoreEmail('news@company.example', 'Check out our product release notes.', [
      { text: 'Read notes', href: 'https://bit.ly/3xyz' },
    ]);
    expect(marketingShortLink.level).toBe('safe');
  });
});

describe('shownHost stays linear on long punctuation runs', () => {
  it('handles 90k dots inside link text quickly and still trims trailing punctuation', () => {
    const t = performance.now();
    shownHost(`https://a.com/${'.'.repeat(90_000)}x`);
    expect(performance.now() - t).toBeLessThan(100);
    expect(shownHost('Visit https://www.paypal.com/login.')).toBe('www.paypal.com');
  });
});

describe('a look-alike letter in the TLD of shown link text', () => {
  // 'www.paypal.cоm' (Cyrillic о) reads as www.paypal.com, but its punycode TLD failed isValidDomain, so the text was
  // treated as prose and the mismatch rule never ran.
  const href = 'https://login-check.example-evil.xyz/s';
  it.each(['www.paypal.cоm', 'https://www.paypal.cоm/signin', 'appleid.apple.сom', 'paypal.cоm', '(www.paypal.cоm).'])(
    '%s is a shown domain that mismatches its link',
    (text) => {
      expect(shownHost(text)).toMatch(/\.xn--[a-z0-9-]+$/);
      expect(extractFeatures('x@sender.example', 'Hello', [{ text, href }]).n_text_href_mismatch).toBe(1);
      expect(scoreEmail('x@sender.example', 'Hello', [{ text, href }]).level).not.toBe('safe');
    },
  );
  it('a real IDN address matching its link is no mismatch, and all-non-ASCII bare text stays prose', () => {
    const f = extractFeatures('x@sender.example', 'Hello', [{ text: 'https://пример.рф/', href: 'https://xn--e1afmkfd.xn--p1ai/' }]);
    expect(f.n_text_href_mismatch).toBe(0);
    expect(shownHost('https://пример.рф/')).toBe('xn--e1afmkfd.xn--p1ai');
    expect(shownHost('Нажмите.здесь')).toBe('');
    expect(shownHost('пример.рф')).toBe('');
  });
});

describe('urgency words spelled with look-alike letters', () => {
  // NFKC keeps Cyrillic/Greek letters, so 'pаssword expirеd' (Cyrillic а, е) used to count no urgency words.
  const body = 'Your pаssword expirеd. Vеrify immеdiately or your mailbox will be suspеnded.';
  it('counts them as the reader reads them', () => {
    expect(extractFeatures('it@corp.example', body, []).urgency_hits).toBe(5);
    expect(scoreEmail('it@corp.example', body, [{ text: 'Keep my mailbox', href: 'https://evil.example/owa' }]).level).toBe(
      'suspicious',
    );
  });
  it('leaves words written wholly in Cyrillic or Greek alone', () => {
    expect(extractFeatures('a@b.example', 'Срочно смените пароль: аккаунт заблокирован. Ορέστης', []).urgency_hits).toBe(0);
    expect(extractFeatures('a@b.example', 'сосна рос ехе', []).urgency_hits).toBe(0);
    expect(extractFeatures('a@b.example', 'Verify your password', []).urgency_hits).toBe(2);
  });
});

describe("the sender's own domain shown on an email-service click-tracking link", () => {
  // ESPs rewrite every link to their click tracker, so 'www.acme.com' in an acme.com newsletter pointed elsewhere and
  // counted as a text/href mismatch (+0.4), locking ordinary newsletters and verification emails.
  const tracked = 'https://u1234567.ct.sendgrid.net/ls/click?upn=u001.abc';
  it('is no mismatch for the sender itself', () => {
    expect(
      scoreEmail('news@acme.com', 'Autumn news. www.acme.com', [
        { text: 'www.acme.com', href: 'https://acme.us12.list-manage.com/track/click?u=a&id=b&e=c' },
      ]).level,
    ).toBe('safe');
    expect(
      scoreEmail('no-reply@acme.com', 'Reset your password. If the button does not work, paste this link: https://app.acme.com/reset?t=1', [
        { text: 'Reset password', href: tracked },
        { text: 'https://app.acme.com/reset?t=1', href: tracked },
      ]).level,
    ).toBe('safe');
    for (const href of [
      'https://d2abc04.na1.hubspotlinks.com/Ctc/xyz',
      'https://ctrk.klclick.com/ls/click?upn=abc',
      'https://abc123.r.us-east-1.awstrack.me/L0/https:%2F%2Fwww.acme.com%2F/1/0100-abc/xyz=',
      'https://click.pstmrk.it/3s/www.acme.com%2F/abc/def',
      'https://mandrillapp.com/track/click/30001234/www.acme.com?p=e',
      'https://r20.rs6.net/tn.jsp?f=001abc&c=xyz',
    ]) {
      expect(scoreEmail('news@acme.com', 'Our news', [{ text: 'www.acme.com', href }]).reasons, href).toEqual([]);
    }
  });
  it("still flags anyone else's domain on a tracker, an unknown redirector, and the parity feature is unchanged", () => {
    const paypal = scoreEmail('alerts@random-shop.com', 'Your account is locked. Verify now.', [
      { text: 'www.paypal.com', href: tracked },
    ]);
    expect(paypal.level).toBe('likely-phishing');
    expect(scoreEmail('news@acme.com', 'Our news', [{ text: 'www.acme.com', href: 'https://evil.example/r' }]).level).not.toBe(
      'safe',
    );
    expect(scoreEmail('', 'Our news', [{ text: 'www.acme.com', href: tracked }]).level).not.toBe('safe');
    expect(extractFeatures('news@acme.com', 'x', [{ text: 'www.acme.com', href: tracked }]).n_text_href_mismatch).toBe(1);
    // Showing its own domain does not hide an urgent tracked link from the external-link rule.
    const urgent = 'Your password expired. Verify immediately or your account will be suspended.';
    expect(scoreEmail('it@corp.example', urgent, [{ text: 'corp.example/login', href: tracked }]).level).toBe('suspicious');
  });
});
