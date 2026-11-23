import type { KV } from './storage';

const KEY = 'trustedSenders';
const MAX = 1000;

// Strict, ASCII-only address check. Trust is per exact address: never per domain, never per display name.
// Local part: letters, digits and . _ % + -, starts and ends with a letter or digit, no "..".
// Domain: 2+ labels of letters, digits and inner hyphens (punycode "xn--" labels allowed), alphabetic TLD.
const LOCAL = '[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?';
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
export const STRICT_EMAIL = new RegExp(`^${LOCAL}@(?:${LABEL}\\.)+[a-z]{2,63}$`);

/**
 * Returns the exact lowercased address, or '' if the input is not exactly one valid address.
 * Accepts "a@b.com" or "Name <a@b.com>" (one pair of angle brackets). Rejects lists, quotes, comments,
 * IP-literal domains, consecutive dots and anything over 254 characters.
 */
export function normalizeSender(input: string): string {
  const s = input.trim();
  if (s.length > 320 || /[,;"()\\\s]/.test(s.replace(/^[^<]*</, '').replace(/>$/, ''))) return '';
  const brackets = (s.match(/</g) ?? []).length;
  if (brackets > 1 || (s.match(/>/g) ?? []).length !== brackets) return '';
  const addr = (brackets ? (s.match(/<([^<>]*)>$/)?.[1] ?? '') : s).toLowerCase();
  return addr.length <= 254 && !addr.includes('..') && STRICT_EMAIL.test(addr) ? addr : '';
}

export async function listTrusted(kv: KV): Promise<string[]> {
  const v = (await kv.get(KEY))[KEY];
  // Re-validate on read: ignore anything malformed or non-exact that got into storage.
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && normalizeSender(x) === x) : [];
}

export async function isTrusted(kv: KV, sender: string): Promise<boolean> {
  const addr = normalizeSender(sender);
  return addr !== '' && (await listTrusted(kv)).includes(addr);
}

export async function trustSender(kv: KV, sender: string): Promise<boolean> {
  const addr = normalizeSender(sender);
  if (!addr) return false;
  const list = await listTrusted(kv);
  if (!list.includes(addr)) await kv.set({ [KEY]: [addr, ...list].slice(0, MAX) });
  return true;
}

export async function untrustSender(kv: KV, sender: string): Promise<void> {
  const addr = normalizeSender(sender);
  await kv.set({ [KEY]: (await listTrusted(kv)).filter((s) => s !== addr) });
}
