import { describe, expect, it } from 'vitest';
import { isCloudHtmlLink, scoreEmail, shownHost } from './features';

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
});
