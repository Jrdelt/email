import type { KV } from './storage';

const KEY = 'trustedSenders';
const MAX = 1000;
const EMAIL_KEY = 'trustedEmails';
const MAX_EMAILS = 500;
const HASH_RE = /^[a-f0-9]{64}$/;

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
  const rawAddr = brackets ? (s.match(/<([^<>]*)>$/)?.[1] ?? '') : s;
  // ASCII only, checked BEFORE lowercasing: 'K' (U+212A KELVIN SIGN) would otherwise fold into an ASCII 'k'.
  if (/[^\x00-\x7f]/.test(rawAddr)) return '';
  const addr = rawAddr.toLowerCase();
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

/**
 * One-way SHA-256 fingerprint of an email (never stores body, URLs, or sender address). Webmail's
 * authentication flags are part of it, so a spoofed copy of a trusted email that webmail marks as unverified
 * (or that arrives through a different relay) does not inherit the original's trust. Emails without those
 * flags hash exactly as before, so existing trusted fingerprints stay valid.
 */
export async function hashEmail(
  senderAddress: string,
  body: string,
  links: readonly { href: string }[],
  attachmentNames?: readonly string[],
  auth: { unauthenticated?: boolean; viaDomain?: string } = {},
): Promise<string> {
  const normSender = senderAddress.trim().toLowerCase();
  const normBody = body.replace(/\s+/g, ' ').trim();
  const normLinks = links.map((l) => l.href.trim()).join('\n');
  const normAtts = attachmentNames?.length
    ? `\0att:${attachmentNames.map((n) => n.trim().toLowerCase()).filter(Boolean).sort().join('\n')}`
    : '';
  const via = auth.viaDomain?.trim().toLowerCase() ?? '';
  const normAuth = `${auth.unauthenticated ? '\0auth:unverified' : ''}${via ? `\0via:${via}` : ''}`;
  const bytes = new TextEncoder().encode(`v1\0${normSender}\0${normBody}\0${normLinks}${normAtts}${normAuth}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function listTrustedEmails(kv: KV): Promise<string[]> {
  const v = (await kv.get(EMAIL_KEY))[EMAIL_KEY];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && HASH_RE.test(x)) : [];
}

export async function isEmailTrusted(kv: KV, hash: string): Promise<boolean> {
  return HASH_RE.test(hash) && (await listTrustedEmails(kv)).includes(hash);
}

export async function trustEmails(kv: KV, hashes: readonly string[]): Promise<void> {
  const valid = hashes.filter((h) => HASH_RE.test(h));
  if (valid.length === 0) return;
  const existing = await listTrustedEmails(kv);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const h of [...valid, ...existing]) {
    if (seen.has(h)) continue;
    seen.add(h);
    next.push(h);
    if (next.length >= MAX_EMAILS) break;
  }
  await kv.set({ [EMAIL_KEY]: next });
}

export async function clearTrustedEmails(kv: KV): Promise<void> {
  await kv.set({ [EMAIL_KEY]: [] });
}

export async function untrustEmails(kv: KV, hashes: readonly string[]): Promise<void> {
  const drop = new Set(hashes.filter((h) => HASH_RE.test(h)));
  if (drop.size === 0) return;
  const remaining = (await listTrustedEmails(kv)).filter((h) => !drop.has(h));
  await kv.set({ [EMAIL_KEY]: remaining });
}
