import type { Verdict } from './features';
import type { KV } from './storage';

// False-positive reports stay on this device (never sent). The user can view and clear them in the popup.
// No email body, sender or full URLs are stored: only the verdict level, score and reason text.
const KEY = 'falsePositiveReports';
const MAX = 50;

export interface FalsePositiveReport { at: string; level: Verdict['level']; score: number; reasons: string[] }

export async function listReports(kv: KV): Promise<FalsePositiveReport[]> {
  const v = (await kv.get(KEY))[KEY];
  return Array.isArray(v) ? (v as FalsePositiveReport[]) : [];
}

export async function recordFalsePositive(kv: KV, v: Verdict, now = new Date()): Promise<void> {
  const r: FalsePositiveReport = { at: now.toISOString(), level: v.level, score: v.score, reasons: v.reasons.map(redact) };
  await kv.set({ [KEY]: [r, ...(await listReports(kv))].slice(0, MAX) });
}

export async function clearReports(kv: KV): Promise<void> {
  await kv.set({ [KEY]: [] });
}

/** Strip emails, full URLs, IP literals, and domain names so local false-alarm notes retain zero PII/PHI. */
function redact(reason: string): string {
  return reason
    .replace(/https?:\/\/[^\s)<>"]+/gi, '[url]')
    .replace(/[^\s@<>()]+@[^\s@<>()]+/g, '[address]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi, '[domain]');
}
