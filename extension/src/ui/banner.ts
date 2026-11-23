import type { SenderInfo } from '../sender';
import { type IntelState, renderDetails } from './details';

export interface BannerModel {
  level: 'warning' | 'danger'; // warning = informational only; danger = content scorer flagged it and links are locked
  title: string;
  reasons: string[];
  linksLocked: boolean;
  sender?: SenderInfo;
  intel?: IntelState;
}

export interface BannerActions {
  onUnlock(): void; // "I trust this email" — unlock links for this email only
  onTrustSender(): Promise<boolean>; // false if the address is not a valid exact address
  onReport(): Promise<void>; // local false-positive report
  onDismiss(): void;
}

const HOST_ID = 'ped-banner-host';

export function removeBanner(doc: Document = document): void {
  doc.getElementById(HOST_ID)?.remove();
}

/** Renders (or re-renders) the banner in a closed shadow root so webmail CSS can't restyle or hide it. textContent only. */
export function showBanner(model: BannerModel, actions: BannerActions, doc: Document = document): void {
  removeBanner(doc);
  const host = doc.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = `
    .b{position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:8px 12px;color:#fff;font:14px system-ui,sans-serif;
       box-shadow:0 2px 6px #0004;max-height:60vh;overflow:auto}
    .danger{background:#b00020}.warning{background:#8a4b00}
    .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.m{flex:1 1 300px}
    button{font:inherit;border:1px solid #fff;background:transparent;color:#fff;border-radius:4px;padding:3px 8px;cursor:pointer}
    button:disabled{opacity:.5;cursor:default}.x{border:none;font-size:18px;line-height:1}
    details{margin-top:6px}summary{cursor:pointer}ul{margin:4px 0;padding-left:20px}
    dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:6px 0}dt{opacity:.8}dd{margin:0;word-break:break-all}`;
  const bar = doc.createElement('div');
  bar.className = `b ${model.level}`;
  bar.setAttribute('role', 'alert');
  const top = doc.createElement('div');
  top.className = 'row';
  const msg = doc.createElement('span');
  msg.className = 'm';
  const suffix = model.linksLocked ? ' Links are disabled.' : '';
  msg.textContent = `⚠ ${model.title}: ${model.reasons[0] ?? 'check the details'}.${suffix}`;

  const button = (label: string, onClick: (b: HTMLButtonElement) => void, cls = '') => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', () => onClick(b));
    return b;
  };

  top.append(msg);
  if (model.linksLocked) {
    top.append(button('I trust this email', (b) => {
      actions.onUnlock();
      msg.textContent = `⚠ ${model.title}. Links re-enabled for this email.`;
      b.disabled = true;
    }));
  }
  const trust = button('Always trust sender', async (b) => {
    b.disabled = true;
    if (await actions.onTrustSender()) { actions.onUnlock(); removeBanner(doc); }
  });
  if (!model.sender?.valid) {
    trust.disabled = true;
    trust.title = model.sender?.rawAddress ? 'Only a valid, exact email address can be trusted' : 'Sender address could not be read from this page';
  }
  const report = button('Not phishing', async (b) => {
    b.disabled = true;
    await actions.onReport();
    b.textContent = 'Reported (saved locally)';
  });
  const close = button('×', () => { actions.onDismiss(); removeBanner(doc); }, 'x');
  close.setAttribute('aria-label', model.linksLocked ? 'Dismiss warning (links stay disabled)' : 'Dismiss warning');
  top.append(trust, report, close);
  bar.append(top);

  const details = doc.createElement('details');
  const summary = doc.createElement('summary');
  summary.textContent = 'Why? Sender and domain details';
  details.append(summary);
  if (model.reasons.length) {
    const ul = doc.createElement('ul');
    for (const r of model.reasons) { const li = doc.createElement('li'); li.textContent = r; ul.append(li); }
    details.append(ul);
  }
  if (model.sender) details.append(renderDetails(doc, model.sender, model.intel));
  bar.append(details);

  root.append(style, bar);
  (doc.body ?? doc.documentElement).appendChild(host);
}
