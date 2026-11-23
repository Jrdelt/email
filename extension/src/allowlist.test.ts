import { describe, expect, it } from 'vitest';
import { isTrusted, listTrusted, normalizeSender, trustSender, untrustSender } from './allowlist';
import { clearReports, listReports, recordFalsePositive } from './feedback';
import { memoryKV } from './storage';

describe('normalizeSender', () => {
  it.each([
    ['PayPal <Service@PayPal.com>', 'service@paypal.com'],
    ['  a@b.co ', 'a@b.co'],
    ['', ''],
    ['not an address', ''],
  ])('%s -> %s', (input, out) => expect(normalizeSender(input)).toBe(out));
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
