import { normalizeSender } from './allowlist';
import { BRANDS, FREEMAIL, KNOWN_ESP_DOMAINS, SERVICE_PREFIX, SERVICE_WORDS } from './brands';
import { hostOf, isInternational, isMultiPartSuffix, isValidDomain, registrableDomain } from './domain';
import { INVISIBLE_RE, type Link } from './features';
import { ellipsizeMiddle, showable } from './text';

export interface SenderInfo {
  name: string; // display name as shown
  rawAddress: string; // address as shown on the page
  address: string; // strict-validated lowercase address, or '' if invalid
  valid: boolean;
  domain: string; // part after @ (lowercased), even when the address is invalid
  registrable: string; // e.g. mail.paypal.co.uk -> paypal.co.uk
  freemail: boolean;
  linkDomains: string[]; // registrable domains of links that differ from the sender's
  viaDomain?: string; // relay host when shown by webmail (e.g. Gmail "via ...")
  unauthenticated?: boolean; // true when webmail explicitly flags verification failure
  authIssue?: boolean; // true when authentication failed or relay looks suspicious
  warnings: string[]; // shown in the banner; never block anything
  allowlisted?: boolean; // already on "Always trust sender" (attachments still checked where auth is not visible)
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
export function analyzeSender(
  name: string,
  rawAddress: string,
  links: Link[],
  meta: { viaDomain?: string; unauthenticated?: boolean } = {},
): SenderInfo {
  const raw = rawAddress.trim();
  const address = normalizeSender(raw);
  const domain = (raw.includes('@') ? raw.slice(raw.lastIndexOf('@') + 1) : '')
    .toLowerCase()
    .replace(/>$/, '')
    .replace(/\.$/, '');
  const registrable = registrableDomain(domain);
  const displayName = name.trim();
  const warnings: string[] = [];

  const linkDomains = [...new Set(links.map((l) => registrableDomain(hostOf(l.href))).filter((d) => d && d !== registrable))];
  const info: SenderInfo = {
    name: displayName,
    rawAddress: raw,
    address,
    valid: address !== '',
    domain,
    registrable,
    freemail: FREEMAIL.has(registrable),
    linkDomains,
    warnings,
  };

  const via = meta.viaDomain?.trim().toLowerCase().replace(/\.$/, '') ?? '';
  const validVia = via && isValidDomain(via) ? via : '';
  const viaReg = validVia ? registrableDomain(validVia) : '';

  if (meta.unauthenticated) {
    info.unauthenticated = true;
    info.authIssue = true;
    warnings.push('Webmail could not verify that this sender is genuine');
  }

  // Webmail showed a relay that is not a checkable hostname (an IDN TLD such as .xn--p1ai or .рф, an underscore...).
  // Treating it as "no relay" would let a spoofed copy of a trusted address through: fail closed instead.
  if (via && !validVia) {
    info.authIssue = true;
    warnings.push(`Sent through a relay server that could not be checked (${showable(ellipsizeMiddle(via, 120))})`);
  }

  // A relay only counts as the sender's own organisation when the registrable domains match and are not a bare
  // public suffix (two unrelated domains under com.pl must not look like the same organisation).
  const sameOrgVia = viaReg === registrable && !isMultiPartSuffix(registrable);
  if (validVia && viaReg && registrable && !sameOrgVia) {
    info.viaDomain = validVia;
    const labels = validVia.split('.');
    const hasNumericLabel = labels.some((l) => /^\d+$/.test(l));
    const suspiciousVia = isInternational(validVia) || FREEMAIL.has(viaReg) || labels.length >= 4 || hasNumericLabel;
    if (suspiciousVia && !KNOWN_ESP_DOMAINS.has(viaReg)) {
      info.authIssue = true;
      warnings.push(`Sent through a suspicious relay server (${viaReg})`);
    }
  }

  if (!raw) return info;

  if (!info.valid) warnings.push("The sender's email address looks invalid or forged");
  if (domain && isInternational(domain)) {
    warnings.push(`The sender's website (${showable(ellipsizeMiddle(domain, 120))}) uses lookalike characters`);
  }

  // '@' is excluded from the repeated classes and the input is capped so attacker display names cannot cause
  // catastrophic regex backtracking.
  // Match on what the reader sees: fullwidth letters fold to ASCII (NFKC) and characters that render as nothing
  // ("Pay\u00adPal", "Pay\u200bPal") are dropped. The original name is still what warnings display.
  const seenName = displayName.slice(0, 1000).normalize('NFKC').replace(INVISIBLE_RE, '');
  const shownAddr = seenName
    .slice(0, 1000)
    .match(/[^\s<>"'()@]+@[^\s<>"'()@]+\.[a-z]{2,}/i)?.[0]
    ?.toLowerCase();
  if (shownAddr && shownAddr !== address && shownAddr !== raw.toLowerCase()) {
    warnings.push(
      `The display name shows ${showable(ellipsizeMiddle(shownAddr, 120))}, but it was really sent from ${showable(ellipsizeMiddle(raw, 120))}`,
    );
  }

  const splitDisplayName = (s: string) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/[_\-.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const normalizedName = splitDisplayName(seenName);
  // Without camelCase splitting too: "PayPal" / "Your PayPal Account" must match /\bPayPal\b/, which the split
  // form "Pay Pal" does not.
  const plainName = seenName.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const compactName = seenName.toLowerCase().replace(/[\s_.-]+/g, '');
  for (const brand of BRANDS) {
    const brandCompact = brand.name.toLowerCase().replace(/\s+/g, '');
    const names = [normalizedName, plainName];
    const tokenizedClaim =
      names.some((n) => brand.pattern.test(n)) &&
      (names.some((n) => SERVICE_WORDS.test(n)) || compactName === brandCompact);
    const compactClaim =
      compactName.startsWith(brandCompact) && SERVICE_PREFIX.test(compactName.slice(brandCompact.length));
    if ((tokenizedClaim || compactClaim) && registrable && !brand.domains.includes(registrable)) {
      warnings.push(`Claims to be ${brand.name}, but was sent from ${registrable}`);
      break;
    }
  }

  const label = registrable.split('.')[0] ?? '';
  outer: for (const brand of BRANDS) {
    if (brand.domains.includes(registrable)) break;
    const seenLabels = new Set<string>();
    for (const d of brand.domains) {
      const dl = d.split('.')[0]!;
      if (seenLabels.has(dl)) continue; // regional domains share the label; the first (primary) domain is named
      seenLabels.add(dl);
      const lookalike = (label !== dl && skeleton(label) === skeleton(dl)) || (dl.length >= 5 && levenshtein(label, dl) === 1) || label === dl;
      if (label && lookalike) {
        warnings.push(`The sender's website (${registrable}) looks like a copy of ${d}`);
        break outer;
      }
    }
  }
  return info;
}

/** True only when a valid exact sender address has no auth failure or unexpected non-ESP relay. */
export function canTrustByAllowlist(info: SenderInfo): boolean {
  if (!info.valid || info.unauthenticated || info.authIssue) return false;
  if (info.viaDomain) {
    const viaReg = registrableDomain(info.viaDomain);
    const sameOrg = viaReg === info.registrable && !isMultiPartSuffix(info.registrable);
    if (viaReg && !sameOrg && !KNOWN_ESP_DOMAINS.has(viaReg)) return false;
  }
  return true;
}
