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

// Fixed sentences that name a sender, relay or looked-up domain (src/sender.ts, src/domainIntel.ts). The whole
// value is replaced, so it is stripped even when the generic patterns below would miss it: a punycode or
// underscore name, or a long name shortened with an ellipsis that cut out its dots or its '@'. Each `.*` is greedy
// up to fixed wording at the end, so an attacker-chosen value that imitates the wording is still removed whole.
const SITE_TAIL =
  'uses lookalike characters$|looks like a copy of |pretends to be |is brand new \\(|does not exist$|is not registered$|is not set up to send normal email$';
const TEMPLATES: [RegExp, string][] = [
  [new RegExp(`^((?:The sender's website|This destination website) )\\(.*\\)(?= (?:${SITE_TAIL}))`, 's'), '$1([domain])'],
  [/( but belongs to ).*$/s, '$1[domain]'],
  [/^(Sent through a (?:relay server that could not be checked|suspicious relay server) )\(.*\)$/s, '$1([domain])'],
  [/^(Claims to be .*?, but was sent from ).*$/s, '$1[domain]'],
  [/^(The display name shows ).*(, but it was really sent from ).*$/s, '$1[address]$2[address]'],
];

/**
 * Strip attachment filenames, emails, full URLs, IP literals, and domain names so local false-alarm notes retain
 * zero PII/PHI (a filename like "Jane Doe DOB 1980 - MRI.pdf" is health information).
 */
function redact(reason: string): string {
  return TEMPLATES.reduce((r, [re, to]) => r.replace(re, to), reason)
    // Greedy up to the fixed wording that follows every attachment reason: a filename may itself contain quotes.
    .replace(/Attachment ".*" (?=(?:hides|uses|is) )/g, 'Attachment "[file]" ')
    .replace(/(blocked until you trust this email or sender) \(.*\)$/, '$1')
    .replace(/https?:\/\/[^\s)<>"]+/gi, '[url]')
    .replace(/[^\s@<>()]+@[^\s@<>()]+/g, '[address]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, '[ip]')
    // Unicode-aware: look-alike (IDN) domains are named in reasons too, as are punycode TLDs (.xn--p1ai) and long
    // names shortened in the middle with an ellipsis (a label may then be up to 120 characters).
    .replace(
      /(?<![\p{L}\p{N}…-])(?:[\p{L}\p{N}…](?:[\p{L}\p{N}…-]{0,125}[\p{L}\p{N}…])?\.)+(?:\p{L}{2,63}|xn--[a-z0-9-]{1,59})(?![\p{L}\p{N}…-])/giu,
      '[domain]',
    );
}
