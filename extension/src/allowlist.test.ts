import { describe, expect, it } from 'vitest';
import {
  clearTrustedEmails,
  hashEmail,
  isEmailTrusted,
  isTrusted,
  listTrusted,
  listTrustedEmails,
  normalizeSender,
  trustEmails,
  trustSender,
  untrustEmails,
  untrustSender,
} from './allowlist';
import { intelWarnings } from './domainIntel';
import { scoreEmail } from './features';
import { clearReports, listReports, recordFalsePositive } from './feedback';
import { analyzeSender } from './sender';
import { memoryKV } from './storage';

describe('normalizeSender', () => {
  it.each([
    ['PayPal <Service@PayPal.com>', 'service@paypal.com'],
    ['  a@b.co ', 'a@b.co'],
    ['first.last+tag@mail.example.co.uk', 'first.last+tag@mail.example.co.uk'],
    ['x@xn--pple-43d.com', 'x@xn--pple-43d.com'],
  ])('accepts %s -> %s', (input, out) => expect(normalizeSender(input)).toBe(out));

  it.each([
    '', 'not an address', 'paypal.com', '@paypal.com', 'a@', 'a@b', 'a@b.c', 'a@b.123',
    'a..b@x.com', '.a@x.com', 'a.@x.com', 'a@-x.com', 'a@x-.com', 'a@x..com',
    'a@[1.2.3.4]', 'a@1.2.3.4', '"a b"@x.com', 'a b@x.com', 'a@x.com, b@y.com', 'a@x.com;b@y.com',
    'A <a@x.com> <b@y.com>', 'A <a@x.com', 'A a@x.com>', 'a@x.com (comment)', 'ä@x.com', 'a@exämple.com',
    `${'a'.repeat(65)}@x.com`, `a@${'b'.repeat(250)}.com`,
  ])('rejects %j', (input) => expect(normalizeSender(input)).toBe(''));
});

describe('allowlist', () => {
  it('trusts, dedupes and untrusts', async () => {
    const kv = memoryKV();
    expect(await trustSender(kv, 'Bank <a@bank.com>')).toBe(true);
    await trustSender(kv, 'a@BANK.com');
    expect(await listTrusted(kv)).toEqual(['a@bank.com']);
    expect(await isTrusted(kv, 'a@bank.com')).toBe(true);
    await untrustSender(kv, 'a@bank.com');
    expect(await isTrusted(kv, 'a@bank.com')).toBe(false);
  });
  it('trust is per exact address, not per domain', async () => {
    const kv = memoryKV();
    await trustSender(kv, 'alerts@bank.com');
    expect(await isTrusted(kv, 'alerts@bank.com')).toBe(true);
    expect(await isTrusted(kv, 'other@bank.com')).toBe(false);
    expect(await isTrusted(kv, 'alerts@bank.com.evil.example')).toBe(false);
    expect(await isTrusted(kv, 'alerts@sub.bank.com')).toBe(false);
  });
  it('ignores malformed entries already in storage', async () => {
    const kv = memoryKV();
    await kv.set({ trustedSenders: ['good@x.com', '*@x.com', 'x.com', 'Bad <b@x.com>', 42] });
    expect(await listTrusted(kv)).toEqual(['good@x.com']);
  });
  it('refuses unknown senders', async () => {
    const kv = memoryKV();
    expect(await trustSender(kv, '')).toBe(false);
    expect(await isTrusted(kv, '')).toBe(false);
  });
});

describe('false-positive reports', () => {
  it('stores locally, redacts addresses, URLs, IPs, and domains, caps and clears', async () => {
    const kv = memoryKV();
    for (let i = 0; i < 60; i++) {
      await recordFalsePositive(kv, {
        score: 0.5,
        level: 'suspicious',
        reasons: ['from bob@x.com via evil.example linking https://evil.example/p?id=1 (192.0.2.10)'],
      });
    }
    const r = await listReports(kv);
    expect(r).toHaveLength(50);
    expect(r[0].reasons[0]).toBe('from [address] via [domain] linking [url] ([ip])');
    await clearReports(kv);
    expect(await listReports(kv)).toHaveLength(0);
  });
});

describe('trustedEmails', () => {
  it('computes normalized 64-char SHA-256 digests and distinguishes sender/body/links', async () => {
    const h1 = await hashEmail('  Alerts@Evil.Example ', 'Hello   world\n\nverify  now ', [{ href: ' https://evil.example/a ' }]);
    const h2 = await hashEmail('alerts@evil.example', 'Hello world verify now', [{ href: 'https://evil.example/a' }]);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
    expect(h1).toBe(h2);

    expect(await hashEmail('other@evil.example', 'Hello world verify now', [{ href: 'https://evil.example/a' }])).not.toBe(h1);
    expect(await hashEmail('alerts@evil.example', 'Different body', [{ href: 'https://evil.example/a' }])).not.toBe(h1);
    expect(await hashEmail('alerts@evil.example', 'Hello world verify now', [{ href: 'https://evil.example/b' }])).not.toBe(h1);
    expect(await hashEmail('alerts@evil.example', 'Hello world verify now', [{ href: 'https://evil.example/a' }], ['a.pdf'])).not.toBe(h1);
    const att1 = await hashEmail('alerts@evil.example', 'Hello', [], ['B.pdf', 'a.pdf']);
    const att2 = await hashEmail('alerts@evil.example', 'Hello', [], ['a.pdf', 'b.pdf']);
    expect(att1).toBe(att2);
  });

  it('persists across reads, dedupes with recency, caps at 500, and clears', async () => {
    const kv = memoryKV();
    const h1 = await hashEmail('a@evil.example', 'msg 1', []);
    const h2 = await hashEmail('b@evil.example', 'msg 2', []);

    await trustEmails(kv, [h1]);
    expect(await isEmailTrusted(kv, h1)).toBe(true);
    expect(await isEmailTrusted(kv, h2)).toBe(false);

    await trustEmails(kv, [h2, h1]);
    expect(await listTrustedEmails(kv)).toEqual([h2, h1]);

    await untrustEmails(kv, [h1]);
    expect(await listTrustedEmails(kv)).toEqual([h2]);
    expect(await isEmailTrusted(kv, h1)).toBe(false);
    expect(await isEmailTrusted(kv, h2)).toBe(true);

    const many = Array.from({ length: 505 }, (_, i) => i.toString(16).padStart(64, '0'));
    await trustEmails(kv, many);
    const stored = await listTrustedEmails(kv);
    expect(stored).toHaveLength(500);
    expect(stored[0]).toBe(many[0]);

    await clearTrustedEmails(kv);
    expect(await listTrustedEmails(kv)).toEqual([]);
    expect(await isEmailTrusted(kv, h1)).toBe(false);
  });

  it('ignores malformed entries already in storage', async () => {
    const kv = memoryKV();
    const valid = 'a'.repeat(64);
    await kv.set({ trustedEmails: [valid, 'not-a-hash', 'A'.repeat(64), 'bad@evil.com', 123] });
    expect(await listTrustedEmails(kv)).toEqual([valid]);
    expect(await isEmailTrusted(kv, 'not-a-hash')).toBe(false);
  });
});

describe('hashEmail authentication flags', () => {
  it('keeps old fingerprints for normal emails but separates unverified or relayed copies', async () => {
    const args = ['billing@vendor.example', 'Your statement', [{ href: 'https://vendor.example/s' }], ['statement.html']] as const;
    const plain = await hashEmail(...args);
    expect(await hashEmail(...args, {})).toBe(plain);
    expect(await hashEmail(...args, { unauthenticated: true })).not.toBe(plain);
    expect(await hashEmail(...args, { viaDomain: '12.relay.evil.example' })).not.toBe(plain);
  });
});

describe('false-positive report redaction', () => {
  it('never stores attachment filenames, addresses, URLs, IPs or domains', async () => {
    const kv = memoryKV();
    await recordFalsePositive(kv, {
      score: 0.4,
      level: 'suspicious',
      reasons: [
        'Attachment "Jane Doe DOB 1980 - MRI results.pdf.html" is an HTML/SVG web file (.html) commonly used for offline phishing pages',
        'Attachments from untrusted emails are blocked until you trust this email or sender (Jane Doe MRI.pdf, Bob Smith labs.pdf +1 more)',
        'A link goes to http://192.168.4.20/x and [2001:db8::1] via pat@clinic.example on clinic.example',
      ],
    });
    const [r] = await listReports(kv);
    const text = r!.reasons.join('\n');
    for (const leak of ['Jane', 'Bob', 'MRI', '192.168', '2001:db8', 'pat@', 'clinic.example']) expect(text).not.toContain(leak);
    expect(r!.reasons[0]).toContain('Attachment "[file]"');
  });

  it('redacts filenames that contain quotes and look-alike (IDN) domains', async () => {
    const kv = memoryKV();
    await recordFalsePositive(kv, {
      score: 0.4,
      level: 'suspicious',
      reasons: [
        'Attachment "Jane "Doe" is MRI.pdf.html" is an HTML/SVG web file (.html) commonly used for offline phishing pages',
        "The sender's website (pаypal-clínica.com) uses lookalike characters",
        'Claims to be PayPal, but was sent from clínica-pagos.es',
      ],
    });
    const text = (await listReports(kv))[0]!.reasons.join('\n');
    for (const leak of ['Jane', 'Doe', 'MRI', 'clínica', 'pаypal']) expect(text).not.toContain(leak);
    expect(text).toContain('is an HTML/SVG web file');
    expect(text).toContain('Claims to be PayPal');
  });
});

describe('false-positive report redaction of punycode, shortened and relay domains', () => {
  const stored = async (reasons: string[]) => {
    const kv = memoryKV();
    await recordFalsePositive(kv, { score: 0.4, level: 'suspicious', reasons });
    return (await listReports(kv))[0]!.reasons;
  };
  const NOW = Date.parse('2026-11-22T00:00:00Z');

  it('strips domains under a punycode TLD (.xn--p1ai) from sender and lookup warnings', async () => {
    const reasons = [
      ...analyzeSender('Clinic', 'info@clinic.xn--p1ai', []).warnings,
      ...analyzeSender('PayPal Support', 'help@paypal-billing.xn--p1ai', []).warnings,
      ...intelWarnings(
        {
          domain: 'patient-portal.xn--80ase.xn--p1ai',
          checkedAt: '2026-11-22T00:00:00Z',
          rdap: { status: 'ok', registered: '2026-11-19T00:00:00Z' },
          dns: { status: 'ok', mx: [] },
        },
        NOW,
      ),
      'A link says paypal.com but actually goes to login.xn--80ak6aa92e.xn--p1ai',
    ];
    expect(reasons.join('\n')).toContain('xn--p1ai'); // the warnings do name these domains
    const text = (await stored(reasons)).join('\n');
    for (const leak of ['clinic', 'paypal-billing', 'patient-portal', 'xn--']) expect(text).not.toContain(leak);
    expect(text).toContain("The sender's website ([domain]) uses lookalike characters");
    expect(text).toContain("The sender's website ([domain]) is brand new (3 days old)");
    expect(text).toContain('Claims to be PayPal, but was sent from [domain]');
  });

  it('strips the whole of a long domain shortened with an ellipsis, not just its tail', async () => {
    const long = `jane-doe-oncology-patient-records-${'x'.repeat(40)}.клиника-${'y'.repeat(50)}.example`;
    const reasons = analyzeSender('Clinic', `info@${long}`, []).warnings;
    expect(reasons.join('\n')).toContain('…');
    const text = (await stored(reasons)).join('\n');
    for (const leak of ['jane', 'oncology', 'xxxx', 'yyyy', '…']) expect(text).not.toContain(leak);
    expect(text).toContain("The sender's website ([domain]) uses lookalike characters");
  });

  it('strips the whole host from link reasons, with underscores, punctuation or labels longer than a domain', async () => {
    const long = `jane-doe-dob-1980-04-12-mrn-55512-oncology-results-${'x'.repeat(100)}`;
    const reasons = [
      ...scoreEmail('news@shop.example', 'Hello', [{ text: 'Track it', href: 'https://patient_jane_doe.bit.ly/abc' }]).reasons,
      ...scoreEmail('news@shop.example', 'Hello', [{ text: 'Track it', href: 'https://jane~doe!mrn.bit.ly/' }]).reasons,
      ...scoreEmail('news@shop.example', 'Hello', [{ text: 'www.paypal.com', href: `https://${long}.evil.example/` }]).reasons,
      ...scoreEmail('news@shop.example', 'Hello', [{ text: 'Your photo', href: 'https://acct_1_jane.grabify.link/x' }]).reasons,
    ];
    expect(reasons.join('\n')).toContain('jane'); // the reasons do name these hosts
    const text = (await stored(reasons)).join('\n');
    for (const leak of ['jane', 'doe', 'mrn', 'xxxx', 'oncology']) expect(text).not.toContain(leak);
    expect(text).toContain('A link uses a URL shortener ([domain]) that hides its real destination');
    expect(text).toContain('A link says [domain] but actually goes to [domain]');
    expect(text).toContain('A link uses a tracking/IP-logger service ([domain]) that hides where it goes');
  });

  it('strips relay names that are not checkable domains, and long sender addresses', async () => {
    const reasons = [
      ...analyzeSender('Clinic', 'info@clinic.example', [], { viaDomain: 'relay.jane-doe-clinic.xn--p1ai' }).warnings,
      ...analyzeSender('Clinic', 'info@clinic.example', [], { viaDomain: 'jane_doe.relay.example' }).warnings,
      ...analyzeSender('jane.doe@clinic.example', `jane.doe.mrn.${'z'.repeat(120)}@other-clinic.example`, []).warnings,
    ];
    const text = (await stored(reasons)).join('\n');
    for (const leak of ['jane', 'doe', 'mrn', 'zzzz', 'clinic']) expect(text).not.toContain(leak);
    expect(text).toContain('Sent through a relay server that could not be checked ([domain])');
    expect(text).toContain('The display name shows [address], but it was really sent from [address]');
  });
});

describe('normalizeSender ASCII-only', () => {
  it('rejects non-ASCII addresses instead of case-folding them into ASCII', () => {
    expect(normalizeSender('Kate@bank.com')).toBe('');
    expect(normalizeSender('José <jose@bank.com>')).toBe('jose@bank.com');
  });
});

describe('hashEmail attachment count', () => {
  it('counts unnamed attachments without changing fingerprints of fully named ones', async () => {
    const base = ['a@vendor.example', 'Invoice', [], ['invoice.pdf']] as const;
    const plain = await hashEmail(...base);
    expect(await hashEmail(...base, { attachmentCount: 1 })).toBe(plain);
    expect(await hashEmail(...base, { attachmentCount: 2 })).not.toBe(plain);
  });
});
