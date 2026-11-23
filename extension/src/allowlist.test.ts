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
  untrustSender,
} from './allowlist';
import { clearReports, listReports, recordFalsePositive } from './feedback';
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
  it('stores locally, redacts addresses, caps and clears', async () => {
    const kv = memoryKV();
    for (let i = 0; i < 60; i++) {
      await recordFalsePositive(kv, { score: 0.5, level: 'suspicious', reasons: ['from bob@x.com via evil.example'] });
    }
    const r = await listReports(kv);
    expect(r).toHaveLength(50);
    expect(r[0].reasons[0]).toBe('from [address] via evil.example');
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
