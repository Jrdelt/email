import type { Verdict } from './features';
import type { KV } from './storage';

// False-positive reports stay on this device (never sent). The user can view and clear them in the popup.
// No email body, sender, attachment names or full URLs are stored: only the verdict level, score and redacted
// reason text.
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

/**
 * Strip attachment filenames, emails, full URLs, IP literals, and domain names so local false-alarm notes retain
 * zero PII/PHI (a filename like "Jane Doe DOB 1980 - MRI.pdf" is health information).
 */
function redact(reason: string): string {
  return reason
    // Greedy up to the fixed wording that follows every attachment reason: a filename may itself contain quotes.
    .replace(/Attachment ".*" (?=(?:hides|uses|is) )/g, 'Attachment "[file]" ')
    .replace(/(blocked until you trust this email or sender) \(.*\)$/, '$1')
    .replace(/https?:\/\/[^\s)<>"]+/gi, '[url]')
    .replace(/[^\s@<>()]+@[^\s@<>()]+/g, '[address]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, '[ip]')
    // Unicode-aware: look-alike (IDN) sender domains are named in reasons too.
    .replace(/(?<![\p{L}\p{N}-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,63}(?![\p{L}\p{N}-])/gu, '[domain]');
}
