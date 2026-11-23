import type { Verdict } from '../features';

export interface BannerActions {
  onUnlock(): void; // "I trust this email" — unlock links for this email only
  onTrustSender(): Promise<boolean>; // false if sender unknown
  onReport(): Promise<void>; // local false-positive report
}

const HOST_ID = 'ped-banner-host';

export function removeBanner(doc: Document = document): void {
  doc.getElementById(HOST_ID)?.remove();
}

/** Shows the warning in a closed shadow root so webmail CSS can't restyle or hide it. textContent only. */
export function showBanner(verdict: Verdict, canTrustSender: boolean, actions: BannerActions, doc: Document = document): void {
  removeBanner(doc);
  const host = doc.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = `
    .b{position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;flex-wrap:wrap;gap:8px;align-items:center;
       padding:8px 12px;background:#b00020;color:#fff;font:14px system-ui,sans-serif;box-shadow:0 2px 6px #0004}
    .m{flex:1 1 300px}
    button{font:inherit;border:1px solid #fff;background:transparent;color:#fff;border-radius:4px;padding:3px 8px;cursor:pointer}
    button:disabled{opacity:.5;cursor:default}
    .x{border:none;font-size:18px;line-height:1}`;
  const bar = doc.createElement('div');
  bar.className = 'b';
  bar.setAttribute('role', 'alert');
  const msg = doc.createElement('span');
  msg.className = 'm';
  const title = verdict.level === 'likely-phishing' ? 'Likely phishing' : 'Suspicious email';
  msg.textContent = `⚠ ${title}: ${verdict.reasons[0] ?? 'multiple warning signs'}. Links are disabled.`;

  const button = (label: string, onClick: (b: HTMLButtonElement) => void, cls = '') => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', () => onClick(b));
    return b;
  };

  const unlock = button('I trust this email', (b) => {
    actions.onUnlock();
    msg.textContent = `⚠ ${title}. Links re-enabled for this email.`;
    b.disabled = true;
  });
  const trust = button('Always trust sender', async (b) => {
    b.disabled = true;
    if (await actions.onTrustSender()) { actions.onUnlock(); removeBanner(doc); }
    else { b.textContent = 'Sender unknown'; }
  });
  trust.disabled = !canTrustSender;
  if (!canTrustSender) trust.title = 'Sender address could not be read from this page';
  const report = button('Not phishing', async (b) => {
    b.disabled = true;
    await actions.onReport();
    b.textContent = 'Reported (saved locally)';
  });
  const close = button('×', () => removeBanner(doc), 'x');
  close.setAttribute('aria-label', 'Dismiss warning (links stay disabled)');

  bar.append(msg, unlock, trust, report, close);
  root.append(style, bar);
  (doc.body ?? doc.documentElement).appendChild(host);
}
