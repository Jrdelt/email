import { ageDays, type DomainIntel } from '../domainIntel';
import type { Verdict } from '../features';
import type { SenderInfo } from '../sender';

export type IntelState = DomainIntel | 'loading' | 'unavailable' | 'offline' | undefined;

const fmtDate = (iso?: string) => (iso ? iso.slice(0, 10) : 'unknown');

export function formatAge(days?: number): string {
  if (days === undefined) return '';
  if (days < 1) return 'created today';
  if (days === 1) return '1 day old';
  if (days < 60) return `${days} days old`;
  if (days < 365) {
    const m = Math.floor(days / 30);
    return m === 1 ? '1 month old' : `${m} months old`;
  }
  const y = Math.floor(days / 365);
  return y === 1 ? '1 year old' : `${y} years old`;
}

function appendRow(doc: Document, dl: HTMLDListElement, k: string, v: string) {
  const dt = doc.createElement('dt');
  dt.textContent = k;
  const dd = doc.createElement('dd');
  dd.textContent = v;
  dl.append(dt, dd);
}

/** Plain-English summary for everyday users. textContent only. */
export function renderSimpleDetails(doc: Document, s: SenderInfo, intel: IntelState): HTMLElement {
  const dl = doc.createElement('dl');
  appendRow(doc, dl, 'Sent by', s.name ? `${s.name} (${s.rawAddress})` : s.rawAddress || 'Unknown');

  let website = 'Unknown';
  if (s.registrable) {
    website = s.registrable + (s.freemail ? ' (free email account)' : '');
    if (intel === 'loading') website += ' — checking…';
    else if (intel === 'offline') website += ' — offline (Strict Local Mode)';
    else if (typeof intel === 'object') {
      if (intel.rdap.status === 'ok') {
        const age = formatAge(ageDays(intel.rdap.registered));
        if (age) website += ` — ${age}`;
      } else if (intel.dns.status === 'ok' && intel.dns.nxdomain) {
        website += ' — does not exist';
      } else if (intel.rdap.status === 'notfound') {
        website += ' — not registered';
      }
    }
  }
  appendRow(doc, dl, 'Website', website);

  const spamText =
    intel === 'loading'
      ? 'Checking…'
      : intel === 'offline'
        ? 'Skipped (Strict Local Mode — 0 network lookups)'
        : !intel && s.allowlisted
          ? 'Not checked (trusted sender)'
          : intel === 'unavailable' || !intel
            ? 'Not available right now'
          : intel.reputation.status === 'ok'
            ? intel.reputation.listed.length
              ? 'Reported for spam online'
              : 'No spam reports found'
            : 'Could not check right now';
  appendRow(doc, dl, 'Spam check', spamText);

  const linksText = s.linkDomains.length
    ? `Other websites: ${s.linkDomains.slice(0, 3).join(', ')}${s.linkDomains.length > 3 ? ` (+${s.linkDomains.length - 3} more)` : ''}`
    : 'Same website as sender (or no links)';
  appendRow(doc, dl, 'Links go to', linksText);
  return dl;
}

function itRows(s: SenderInfo, intel: IntelState, verdict?: Verdict): [string, string][] {
  const rows: [string, string][] = [];
  if (verdict) rows.push(['Verdict', `${verdict.level} (score ${verdict.score.toFixed(2)})`]);
  rows.push(['From', s.name ? `${s.name} <${s.rawAddress}>` : s.rawAddress || 'unknown']);
  rows.push(['Address format', s.valid ? `${s.address} (valid format)` : 'invalid format']);
  if (s.registrable) {
    rows.push(['Domain', `${s.registrable}${s.domain !== s.registrable ? ` (sent from ${s.domain})` : ''}${s.freemail ? ', free email provider' : ''}`]);
  }
  if (s.viaDomain) rows.push(['Relay (via)', s.viaDomain]);
  if (s.unauthenticated) rows.push(['Authentication', 'unverified by webmail']);
  if (intel === 'loading') rows.push(['Domain lookup', 'checking…']);
  else if (intel === 'offline') rows.push(['Domain lookup', 'disabled (Strict Local Mode — zero network lookups)']);
  else if (intel === 'unavailable') rows.push(['Domain lookup', 'unavailable']);
  else if (intel) {
    const r = intel.rdap;
    if (r.status === 'ok') {
      const age = ageDays(r.registered);
      rows.push(['Registered', `${fmtDate(r.registered)}${age !== undefined ? ` (${age} days ago)` : ''}`]);
      rows.push(['Registrar', r.registrar ?? 'unknown']);
      rows.push(['Expires', fmtDate(r.expires)]);
    } else {
      const msg =
        r.status === 'unsupported'
          ? 'RDAP not available for this TLD'
          : r.status === 'notfound'
            ? 'domain not registered'
            : 'lookup failed';
      rows.push(['Registration', msg]);
    }
    const d = intel.dns;
    if (d.status === 'ok') {
      if (d.nxdomain) {
        rows.push(['DNS', 'domain does not exist (NXDOMAIN)']);
      } else {
        rows.push(['Mail servers (MX)', d.mx.length ? d.mx.slice(0, 3).join(', ') + (d.mx.length > 3 ? ` +${d.mx.length - 3}` : '') : 'none']);
        rows.push(['SPF', d.spf ? 'published' : 'missing']);
        rows.push(['DMARC', d.dmarcPolicy ? `policy ${d.dmarcPolicy}` : 'missing']);
      }
    } else {
      rows.push(['DNS', 'lookup failed']);
    }
    const rep = intel.reputation;
    rows.push([
      'Spam list (URIBL)',
      rep.status === 'ok'
        ? rep.listed.length
          ? `listed: ${rep.listed.join(', ')}`
          : 'not listed'
        : rep.status === 'refused'
          ? 'lookup refused'
          : 'lookup failed',
    ]);
  }
  rows.push([
    'External link domains',
    s.linkDomains.length ? s.linkDomains.slice(0, 5).join(', ') + (s.linkDomains.length > 5 ? ` +${s.linkDomains.length - 5}` : '') : 'none (sender domain only)',
  ]);
  return rows;
}

/** Plain-text technical summary for copying into an IT ticket (never contains email body). */
export function formatITReport(s: SenderInfo, intel: IntelState, verdict?: Verdict, allReasons?: string[]): string {
  const lines = itRows(s, intel, verdict).map(([k, v]) => `${k}: ${v}`);
  if (allReasons?.length) {
    lines.push('', 'Signals:', ...allReasons.map((r) => `- ${r}`));
  }
  return lines.join('\n');
}

function copyTextWithFallback(doc: Document, text: string): boolean {
  const host = doc.body ?? doc.documentElement;
  if (!host) return false;
  const ta = doc.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
  host.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = typeof doc.execCommand === 'function' && doc.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    ta.remove();
  }
  return ok;
}

/** Technical diagnostics + copy button for IT. textContent only. */
export function renderITDetailsContent(
  doc: Document,
  s: SenderInfo,
  intel: IntelState,
  verdict?: Verdict,
  allReasons?: string[],
): DocumentFragment {
  const frag = doc.createDocumentFragment();
  const dl = doc.createElement('dl');
  for (const [k, v] of itRows(s, intel, verdict)) appendRow(doc, dl, k, v);
  frag.append(dl);

  if (allReasons && allReasons.length > 3) {
    const ul = doc.createElement('ul');
    ul.className = 'signals';
    for (const r of allReasons) {
      const li = doc.createElement('li');
      li.textContent = r;
      ul.append(li);
    }
    frag.append(ul);
  }

  const copyBtn = doc.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'copy-it';
  copyBtn.textContent = 'Copy details for IT';
  copyBtn.addEventListener('click', () => {
    const text = formatITReport(s, intel, verdict, allReasons);
    void (async () => {
      try {
        const clip = navigator.clipboard?.writeText;
        if (!clip) throw new Error('clipboard unavailable');
        await Promise.resolve(clip.call(navigator.clipboard, text));
        copyBtn.textContent = 'Copied!';
      } catch {
        copyBtn.textContent = copyTextWithFallback(doc, text) ? 'Copied!' : 'Copy failed';
      }
    })();
  });
  frag.append(copyBtn);
  return frag;
}

/** Technical diagnostics wrapped in a collapsed "More options for IT" <details> section. */
export function renderITDetails(
  doc: Document,
  s: SenderInfo,
  intel: IntelState,
  verdict?: Verdict,
  allReasons?: string[],
): HTMLDetailsElement {
  const details = doc.createElement('details');
  details.className = 'it';
  const summary = doc.createElement('summary');
  summary.textContent = 'More options for IT';
  details.append(summary, renderITDetailsContent(doc, s, intel, verdict, allReasons));
  return details;
}
