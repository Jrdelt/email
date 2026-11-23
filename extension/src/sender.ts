import { normalizeSender } from './allowlist';
import { BRANDS, FREEMAIL, SERVICE_WORDS } from './brands';
import { hostOf, isInternational, registrableDomain } from './domain';
import type { Link } from './features';

export interface SenderInfo {
  name: string; // display name as shown
  rawAddress: string; // address as shown on the page
  address: string; // strict-validated lowercase address, or '' if invalid
  valid: boolean;
  domain: string; // part after @ (lowercased), even when the address is invalid
  registrable: string; // e.g. mail.paypal.co.uk -> paypal.co.uk
  freemail: boolean;
  linkDomains: string[]; // registrable domains of links that differ from the sender's
  warnings: string[]; // shown in the banner; never block anything
}

const CONFUSABLES: [RegExp, string][] = [[/0/g, 'o'], [/[1i]/g, 'l'], [/3/g, 'e'], [/5/g, 's'], [/rn/g, 'm'], [/vv/g, 'w']];
const skeleton = (s: string) => CONFUSABLES.reduce((acc, [re, to]) => acc.replace(re, to), s.toLowerCase());

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Local-only sender analysis. Produces warnings; never rejects or blocks. */
export function analyzeSender(name: string, rawAddress: string, links: Link[]): SenderInfo {
  const raw = rawAddress.trim();
  const address = normalizeSender(raw);
  const domain = (raw.includes('@') ? raw.slice(raw.lastIndexOf('@') + 1) : '').toLowerCase().replace(/>$/, '');
  const registrable = registrableDomain(domain);
  const displayName = name.trim();
  const warnings: string[] = [];

  const linkDomains = [...new Set(links.map((l) => registrableDomain(hostOf(l.href))).filter((d) => d && d !== registrable))];
  const info: SenderInfo = { name: displayName, rawAddress: raw, address, valid: address !== '', domain, registrable, freemail: FREEMAIL.has(registrable), linkDomains, warnings };
  if (!raw) return info;

  if (!info.valid) warnings.push("The sender's email address looks invalid or forged");
  if (domain && isInternational(domain)) warnings.push(`The sender's website (${domain}) uses lookalike characters`);

  const shownAddr = displayName.match(/[^\s<>"'()]+@[^\s<>"'()]+\.[a-z]{2,}/i)?.[0]?.toLowerCase();
  if (shownAddr && shownAddr !== address) warnings.push(`The display name shows ${shownAddr}, but it was really sent from ${raw}`);

  for (const brand of BRANDS) {
    const claims = brand.pattern.test(displayName) && (SERVICE_WORDS.test(displayName) || displayName.toLowerCase() === brand.name.toLowerCase());
    if (claims && registrable && !brand.domains.includes(registrable)) {
      warnings.push(`Claims to be ${brand.name}, but was sent from ${registrable}`);
      break;
    }
  }

  const label = registrable.split('.')[0] ?? '';
  outer: for (const brand of BRANDS) {
    if (brand.domains.includes(registrable)) break;
    for (const d of brand.domains) {
      const dl = d.split('.')[0];
      const lookalike = (label !== dl && skeleton(label) === skeleton(dl)) || (dl.length >= 5 && levenshtein(label, dl) === 1) || label === dl;
      if (label && lookalike) {
        warnings.push(`The sender's website (${registrable}) looks like a copy of ${d}`);
        break outer;
      }
    }
  }
  return info;
}
