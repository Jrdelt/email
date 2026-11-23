import type { KV } from './storage';

const KEY = 'trustedSenders';
const MAX = 1000;

/** Lowercased bare address. "PayPal <a@b.com>" -> "a@b.com". Returns '' if no address. */
export function normalizeSender(s: string): string {
  const m = s.match(/<([^>]+)>/);
  const addr = (m ? m[1] : s).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : '';
}

export async function listTrusted(kv: KV): Promise<string[]> {
  const v = (await kv.get(KEY))[KEY];
  return Array.isArray(v) ? (v as string[]) : [];
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
