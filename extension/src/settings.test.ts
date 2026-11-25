import { describe, expect, it } from 'vitest';
import { clearAllLocalData, getSettings, setStrictLocalMode } from './settings';
import { memoryKV } from './storage';

describe('privacy settings & managed policy', () => {
  it('defaults to strictLocalMode=false and persists local toggles', async () => {
    const kv = memoryKV();
    expect(await getSettings(kv)).toEqual({
      strictLocalMode: false,
      disableLocalReports: false,
      managedLocked: false,
    });
    const updated = await setStrictLocalMode(kv, true);
    expect(updated).toEqual({
      strictLocalMode: true,
      disableLocalReports: false,
      managedLocked: false,
    });
    expect(await getSettings(kv)).toEqual(updated);
  });

  it('enforces enterprise browser.storage.managed overrides and locks user toggle', async () => {
    const local = memoryKV();
    const managed = memoryKV();
    await managed.set({ strictLocalMode: true, disableLocalReports: true });

    const s = await getSettings(local, managed);
    expect(s).toEqual({
      strictLocalMode: true,
      disableLocalReports: true,
      managedLocked: true,
    });

    const attempted = await setStrictLocalMode(local, false, managed);
    expect(attempted.strictLocalMode).toBe(true);
    expect(attempted.managedLocked).toBe(true);
  });

  it('falls back safely when storage.managed throws on unmanaged browsers', async () => {
    const local = memoryKV();
    await setStrictLocalMode(local, true);
    const throwingManaged = {
      get: async () => {
        throw new Error('Managed storage manifest not found');
      },
    };
    const s = await getSettings(local, throwingManaged);
    expect(s).toEqual({
      strictLocalMode: true,
      disableLocalReports: false,
      managedLocked: false,
    });
  });

  it('clears all stored allowlists, digests, reports, and caches while preserving privacy mode', async () => {
    const local = memoryKV();
    await setStrictLocalMode(local, true);
    await local.set({
      trustedSenders: ['a@example.com'],
      trustedEmails: ['abc123'],
      falsePositiveReports: [{ at: '2026-11-23T00:00:00Z', level: 'suspicious', score: 0.4, reasons: ['r'] }],
      domainIntelCache: { 'example.com': { at: 1 } },
      rdapBootstrap: { at: 1 },
    });

    await clearAllLocalData(local);
    expect(await getSettings(local)).toMatchObject({ strictLocalMode: true });
    expect((await local.get('trustedSenders')).trustedSenders).toEqual([]);
    expect((await local.get('trustedEmails')).trustedEmails).toEqual([]);
    expect((await local.get('falsePositiveReports')).falsePositiveReports).toEqual([]);
    expect((await local.get('domainIntelCache')).domainIntelCache).toEqual({});
  });
});

describe('setStrictLocalMode keeps managed policy out of local storage', () => {
  it('does not persist a managed disableLocalReports when the user toggles strict mode', async () => {
    const local = memoryKV();
    const managed = { get: async (k: string) => (k === 'disableLocalReports' ? { disableLocalReports: true } : {}) };
    await setStrictLocalMode(local, true, managed);
    const afterPolicyRemoved = await getSettings(local, { get: async () => ({}) });
    expect(afterPolicyRemoved.strictLocalMode).toBe(true);
    expect(afterPolicyRemoved.disableLocalReports).toBe(false);
  });
});

describe('Strict Local Mode clears lookup caches', () => {
  it('removes cached domain intel when turned on', async () => {
    const kv = memoryKV() as ReturnType<typeof memoryKV> & { remove?: (k: string | string[]) => Promise<void> };
    await kv.set({ domainIntelCache: { 'evil.example': {} }, rdapBootstrap: { at: 1, map: {} } });
    await setStrictLocalMode(kv, true);
    expect(Object.keys((await kv.get('domainIntelCache')).domainIntelCache as object)).toEqual([]);
  });
});

describe('unreadable settings', () => {
  it('assume Strict Local Mode when the local setting cannot be read (managed policy still wins)', async () => {
    const broken = { get: async () => { throw new Error('io'); } };
    expect((await getSettings(broken)).strictLocalMode).toBe(true);
    const managed = { get: async (k: string) => (k === 'strictLocalMode' ? { strictLocalMode: false } : {}) };
    expect((await getSettings(broken, managed)).strictLocalMode).toBe(false);
  });
});
