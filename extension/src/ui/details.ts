import { ageDays, type DomainIntel } from '../domainIntel';
import type { SenderInfo } from '../sender';

export type IntelState = DomainIntel | 'loading' | 'unavailable' | undefined;

const fmtDate = (iso?: string) => (iso ? iso.slice(0, 10) : 'unknown');

/** Sender + domain facts as a <dl>. textContent only. Shared by the banner and the popup. */
export function renderDetails(doc: Document, s: SenderInfo, intel: IntelState): HTMLElement {
  const dl = doc.createElement('dl');
  const row = (k: string, v: string) => {
    const dt = doc.createElement('dt');
    dt.textContent = k;
    const dd = doc.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  };
  row('From', s.name ? `${s.name} <${s.rawAddress}>` : s.rawAddress || 'unknown');
  row('Address', s.valid ? `${s.address} (valid format)` : 'invalid format');
  if (s.registrable) {
    row('Domain', `${s.registrable}${s.domain !== s.registrable ? ` (sent from ${s.domain})` : ''}${s.freemail ? ', free email provider' : ''}`);
  }
  if (intel === 'loading') row('Domain lookup', 'checking…');
  else if (intel === 'unavailable') row('Domain lookup', 'unavailable');
  else if (intel) {
    const r = intel.rdap;
    if (r.status === 'ok') {
      const age = ageDays(r.registered);
      row('Registered', `${fmtDate(r.registered)}${age !== undefined ? ` (${age} days ago)` : ''}`);
      row('Registrar', r.registrar ?? 'unknown');
      row('Expires', fmtDate(r.expires));
    } else row('Registration', r.status === 'notfound' ? 'domain not registered' : 'lookup failed');
    const d = intel.dns;
    if (d.status === 'ok') {
      row('Mail servers', d.mx.length ? d.mx.slice(0, 3).join(', ') + (d.mx.length > 3 ? ` +${d.mx.length - 3}` : '') : 'none');
      row('SPF', d.spf ? 'published' : 'missing');
      row('DMARC', d.dmarcPolicy ? `policy ${d.dmarcPolicy}` : 'missing');
    } else row('DNS', 'lookup failed');
    const rep = intel.reputation;
    row('Spam reports (URIBL)', rep.status === 'ok' ? (rep.listed.length ? `listed: ${rep.listed.join(', ')}` : 'not listed')
      : rep.status === 'refused' ? 'lookup refused' : 'lookup failed');
  }
  row('Links go to', s.linkDomains.length ? s.linkDomains.slice(0, 5).join(', ') + (s.linkDomains.length > 5 ? ` +${s.linkDomains.length - 5}` : '') : 'sender domain or none');
  return dl;
}
