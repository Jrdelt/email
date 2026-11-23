import { describe, expect, it } from 'vitest';
import { isTrusted, listTrusted, normalizeSender, trustSender, untrustSender } from './allowlist';
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
