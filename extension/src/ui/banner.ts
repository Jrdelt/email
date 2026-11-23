import { intelWarnings } from '../domainIntel';
import type { Verdict } from '../features';
import type { SenderInfo } from '../sender';
import { type IntelState, renderITDetails, renderSimpleDetails } from './details';

export interface BannerModel {
  level: 'warning' | 'danger'; // warning = informational only; danger = content scorer flagged it and links are locked
  title: string;
  reasons: string[];
  linksLocked: boolean;
  verdict?: Verdict;
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

/** Decide whether to show a banner and build its display model; returns null for safe emails with no sender/domain warnings. */
export function decideBanner(
  verdict: Verdict,
  sender: SenderInfo,
  intel: IntelState,
  unlockedThisSession: boolean,
): BannerModel | null {
  const danger = verdict.level !== 'safe';
  const senderWarnings = [...sender.warnings, ...(typeof intel === 'object' ? intelWarnings(intel) : [])];
  if (!danger && senderWarnings.length === 0) return null;
  const reasons = danger ? [...verdict.reasons, ...senderWarnings] : [...senderWarnings, ...verdict.reasons];
  const title = danger
    ? verdict.level === 'likely-phishing'
      ? 'Possible phishing email'
      : 'This email looks suspicious'
    : 'Double-check this sender';
  return {
    level: danger ? 'danger' : 'warning',
    title,
    reasons,
    linksLocked: danger && !unlockedThisSession,
    verdict,
    sender,
    intel,
  };
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
    dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:6px 0}dt{opacity:.8}dd{margin:0;word-break:break-all}
    .it{margin-top:8px;padding-top:6px;border-top:1px solid #fff4}.more{font-size:12px;opacity:.85}.copy-it{margin-top:6px}`;
  const bar = doc.createElement('div');
  bar.className = `b ${model.level}`;
  bar.setAttribute('role', 'alert');
  const top = doc.createElement('div');
  top.className = 'row';
  const msg = doc.createElement('span');
  msg.className = 'm';
  const primary = (model.reasons[0] ?? 'check before clicking').slice(0, 140);
  const suffix = model.linksLocked ? ' Links are paused.' : '';
  msg.textContent = `⚠ ${model.title}: ${primary}.${suffix}`;

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
      msg.textContent = `⚠ ${model.title}. Links are enabled for this email.`;
      b.disabled = true;
    }));
  }
  const trust = button('Always trust sender', async (b) => {
    b.disabled = true;
    if (await actions.onTrustSender()) { actions.onUnlock(); removeBanner(doc); }
  });
  if (!model.sender?.valid) {
    trust.disabled = true;
    trust.title = "Sender address couldn't be verified";
  }
  const report = button('Not phishing', async (b) => {
    b.disabled = true;
    await actions.onReport();
    b.textContent = 'Reported (saved locally)';
  });
  const close = button('×', () => { actions.onDismiss(); removeBanner(doc); }, 'x');
  close.setAttribute('aria-label', model.linksLocked ? 'Dismiss warning (links stay paused)' : 'Dismiss warning');
  top.append(trust, report, close);
  bar.append(top);

  const details = doc.createElement('details');
  const summary = doc.createElement('summary');
  summary.textContent = 'See why';
  details.append(summary);
  if (model.reasons.length) {
    const ul = doc.createElement('ul');
    for (const r of model.reasons.slice(0, 3)) { const li = doc.createElement('li'); li.textContent = r; ul.append(li); }
    details.append(ul);
    if (model.reasons.length > 3) {
      const more = doc.createElement('div');
      more.className = 'more';
      more.textContent = `+${model.reasons.length - 3} more in IT options`;
      details.append(more);
    }
  }
  if (model.sender) {
    details.append(
      renderSimpleDetails(doc, model.sender, model.intel),
      renderITDetails(doc, model.sender, model.intel, model.verdict, model.reasons),
    );
  }
  bar.append(details);

  root.append(style, bar);
  (doc.body ?? doc.documentElement).appendChild(host);
}
