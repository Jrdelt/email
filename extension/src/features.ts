// Mirror of ml/src/phishml/features.py — keep in sync (parity-tested).
export interface Link { text: string; href: string }
export interface Verdict { score: number; level: 'safe' | 'suspicious' | 'likely-phishing'; reasons: string[] }

const URGENCY = ['urgent', 'immediately', 'verify', 'suspended', 'locked', 'password', 'confirm', 'act now', 'expires'];
const IP_HOST = /^\d{1,3}(\.\d{1,3}){3}$/;

const host = (u: string): string => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const registrable = (h: string): string => h.split('.').slice(-2).join('.');

export function scoreEmail(sender: string, body: string, links: Link[]): Verdict {
  const reasons: string[] = [];
  let score = 0;
  const lower = body.toLowerCase();
  for (const l of links) {
    const h = host(l.href);
    if (IP_HOST.test(h)) { score += 0.3; reasons.push(`Link points to a raw IP address (${h})`); }
    if (h.includes('xn--')) { score += 0.3; reasons.push(`Link uses a punycode domain (${h})`); }
    if (l.text.includes('.')) {
      const shown = host(l.text.includes('://') ? l.text : `https://${l.text.trim()}`);
      if (shown && h && registrable(shown) !== registrable(h)) {
        score += 0.4; reasons.push(`Link text shows ${shown} but goes to ${h}`);
      }
    }
  }
  const hits = URGENCY.reduce((n, w) => n + lower.split(w).length - 1, 0);
  if (hits >= 2) { score += 0.2; reasons.push('Urgent or credential-related wording'); }
  score = Math.min(1, score);
  const level = score >= 0.6 ? 'likely-phishing' : score >= 0.3 ? 'suspicious' : 'safe';
  return { score, level, reasons };
}
