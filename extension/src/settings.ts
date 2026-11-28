import type { KV } from './storage';

export interface PrivacySettings {
  strictLocalMode: boolean;
  disableLocalReports: boolean;
  managedLocked: boolean;
}

const SETTINGS_KEY = 'privacySettings';
const LOCAL_DATA_KEYS = [
  'trustedSenders',
  'trustedEmails',
  'falsePositiveReports',
  'domainIntelCache',
  'rdapBootstrap',
] as const;

export interface ReadableKV {
  get(key: string): Promise<Record<string, unknown>>;
}

export interface RemovableKV extends KV {
  remove?(keys: string | string[]): Promise<void>;
}

/**
 * Load effective privacy settings, honoring browser.storage.managed enterprise policy overrides first.
 * In HIPAA-regulated or enterprise environments, IT admins can lock strictLocalMode=true so zero
 * off-device RDAP/DNS requests ever leave the browser.
 */
export async function getSettings(localKV: ReadableKV, managedKV?: ReadableKV): Promise<PrivacySettings> {
  let managedStrict: boolean | undefined;
  let managedNoReports: boolean | undefined;

  if (managedKV?.get) {
    try {
      const [sRes, rRes] = await Promise.all([
        managedKV.get('strictLocalMode'),
        managedKV.get('disableLocalReports'),
      ]);
      if (typeof sRes?.strictLocalMode === 'boolean') managedStrict = sRes.strictLocalMode;
      if (typeof rRes?.disableLocalReports === 'boolean') managedNoReports = rRes.disableLocalReports;
    } catch {
      // Unmanaged browsers (or Firefox without a native policy manifest) may throw; fall back cleanly.
    }
  }

  let localStrict = false;
  let localNoReports = false;
  let localUnreadable = false;
  try {
    const raw = (await localKV.get(SETTINGS_KEY))[SETTINGS_KEY];
    if (raw && typeof raw === 'object') {
      const obj = raw as { strictLocalMode?: unknown; disableLocalReports?: unknown };
      localStrict = obj.strictLocalMode === true;
      localNoReports = obj.disableLocalReports === true;
    }
  } catch {
    // The user's choice cannot be read: assume Strict Local Mode rather than risk lookups they turned off.
    localUnreadable = true;
  }

  const strictLocalMode = managedStrict !== undefined ? managedStrict : localStrict || localUnreadable;
  const disableLocalReports = managedNoReports !== undefined ? managedNoReports : localNoReports;
  const managedLocked = managedStrict !== undefined;
  return { strictLocalMode, disableLocalReports, managedLocked };
}

const LOOKUP_CACHE_KEYS = ['domainIntelCache', 'rdapBootstrap'] as const;

/**
 * Drop cached online-lookup results (sender/destination domains). Used when Strict Local Mode turns on, and each
 * time the background starts in Strict Local Mode, so it writes only when there is something to delete (a key that
 * cannot be read counts as present).
 */
export async function clearLookupCaches(localKV: RemovableKV): Promise<void> {
  const present: string[] = [];
  for (const key of LOOKUP_CACHE_KEYS) {
    try {
      if ((await localKV.get(key))[key] !== undefined) present.push(key);
    } catch {
      present.push(key);
    }
  }
  if (!present.length) return;
  if (localKV.remove) await localKV.remove(present);
  else await localKV.set(Object.fromEntries(present.map((key) => [key, {}])));
}

/** Persist user-selected Strict Local Mode unless overridden by managed enterprise policy. */
export async function setStrictLocalMode(
  localKV: RemovableKV,
  enabled: boolean,
  managedKV?: ReadableKV,
): Promise<PrivacySettings> {
  const current = await getSettings(localKV, managedKV);
  if (current.managedLocked) return current;
  // Keep the user's own disableLocalReports, never the managed-merged value: otherwise an IT policy would be
  // copied into local storage and outlive its removal.
  let localNoReports = false;
  try {
    const raw = (await localKV.get(SETTINGS_KEY))[SETTINGS_KEY] as { disableLocalReports?: unknown } | undefined;
    localNoReports = raw?.disableLocalReports === true;
  } catch {
    // Default when storage read fails.
  }
  await localKV.set({
    [SETTINGS_KEY]: {
      strictLocalMode: Boolean(enabled),
      disableLocalReports: localNoReports,
    },
  });
  // Nothing looked up before should linger once the user asks for zero network use.
  if (enabled) await clearLookupCaches(localKV);
  return { ...current, strictLocalMode: Boolean(enabled) };
}

/** Clear all locally cached sender lists, trusted email digests, false-positive notes, and domain caches. */
export async function clearAllLocalData(localKV: RemovableKV): Promise<void> {
  if (localKV.remove) {
    await localKV.remove([...LOCAL_DATA_KEYS]);
    return;
  }
  await localKV.set({
    trustedSenders: [],
    trustedEmails: [],
    falsePositiveReports: [],
    domainIntelCache: {},
    rdapBootstrap: {},
  });
}
