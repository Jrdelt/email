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
    expect(isCloudHtmlLink('https://storage.googleapis.com/hmdbox/hmd_v2.html#?act=cl')).toBe(true);
    expect(isCloudHtmlLink('https://bucket.s3.amazonaws.com/login.htm')).toBe(true);
    expect(isCloudHtmlLink('https://acct.blob.core.windows.net/c/verify.html')).toBe(true);
    expect(isCloudHtmlLink('https://firebasestorage.googleapis.com/v0/b/x/o/a%2Flogin.html?alt=media')).toBe(true);
    expect(isCloudHtmlLink('https://pub-1.r2.dev/a.html')).toBe(true);

    expect(isCloudHtmlLink('https://storage.googleapis.com/assets/logo.png')).toBe(false);
    expect(isCloudHtmlLink('https://bucket.s3.amazonaws.com/invoice.pdf')).toBe(false);
    expect(isCloudHtmlLink('https://account.mongodb.com/login.html')).toBe(false);

    const phish = scoreEmail(
      'alert-442-320397@nozfr.itl',
      "We've Blocked Your Account! Your photos and videos will be deleted. Please update your billing details. Expiration date: Today.",
      [
        { text: 'Cloud Review billing', href: 'https://storage.googleapis.com/hmdbox/hmd_v2.html#?act=cl' },
        { text: 'Review billing', href: 'https://storage.googleapis.com/hmdbox/hmd_v2.html#?act=cl' },
        { text: 'Unsubscribe', href: 'https://storage.googleapis.com/hmdbox/hmd_v2.html#?act=un' },
        { text: 'here', href: 'https://storage.googleapis.com/hmdbox/hmd_v2.html#?act=oop' },
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
