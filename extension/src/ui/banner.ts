import { intelWarnings } from '../domainIntel';
import type { Verdict } from '../features';
import type { SenderInfo } from '../sender';
import { type IntelState, renderITDetails, renderSimpleDetails } from './details';
import { createCloseIcon, createLockIcon, createStatusIcon } from './icons';

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
const CHEVRON_MASK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' d='M4 6l4 4 4-4'/%3E%3C/svg%3E")`;

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
    linksLocked: !unlockedThisSession,
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
    :host{color-scheme:light dark;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    .wrap{position:fixed;top:12px;left:16px;right:16px;z-index:2147483647;display:flex;justify-content:center;pointer-events:none}
    .card{
      pointer-events:auto;width:100%;max-width:820px;box-sizing:border-box;
      border-radius:12px;padding:12px 14px;font-size:14px;line-height:1.4;
      max-height:72vh;overflow:auto;
      background:var(--bg);color:var(--text);
      border:1px solid var(--border);border-inline-start:4px solid var(--accent);
      box-shadow:0 8px 24px -4px rgb(0 0 0 / .18),0 2px 6px rgb(0 0 0 / .08);
      opacity:1;translate:0;
      transition:opacity .2s ease-out,translate .2s ease-out;
    }
    .card.danger{
      --bg:#fff5f5;--border:#f5c2c7;--accent:#c62828;--title:#991b1b;--text:#1f2937;--muted:#4b5563;
      --badge-bg:#fee2e2;--badge-fg:#b91c1c;--pill-bg:#fee2e2;--pill-fg:#991b1b;
      --panel-bg:#ffffff;--panel-border:#f3d1d5;
      --btn-bg:#ffffff;--btn-fg:#1f2937;--btn-border:#d1d5db;--btn-hover:#fef2f2;
      --btn-primary-bg:#b91c1c;--btn-primary-fg:#ffffff;--btn-primary-border:#991b1b;--btn-primary-hover:#991b1b;
    }
    .card.warning{
      --bg:#fffbeb;--border:#f6d365;--accent:#b45309;--title:#92400e;--text:#1f2937;--muted:#4b5563;
      --badge-bg:#fef3c7;--badge-fg:#b45309;--pill-bg:#fef3c7;--pill-fg:#92400e;
      --panel-bg:#ffffff;--panel-border:#f3e0b5;
      --btn-bg:#ffffff;--btn-fg:#1f2937;--btn-border:#d1d5db;--btn-hover:#fef9e7;
      --btn-primary-bg:#b45309;--btn-primary-fg:#ffffff;--btn-primary-border:#92400e;--btn-primary-hover:#92400e;
    }
    @media (prefers-color-scheme: dark){
      .card{box-shadow:0 12px 28px rgb(0 0 0 / .5)}
      .card.danger{
        --bg:#1f1618;--border:#5c2229;--accent:#f87171;--title:#fca5a5;--text:#f3f4f6;--muted:#d1d5db;
        --badge-bg:#3b181d;--badge-fg:#fca5a5;--pill-bg:#3b181d;--pill-fg:#fecaca;
        --panel-bg:#281c1f;--panel-border:#5c2229;
        --btn-bg:#2a1e21;--btn-fg:#f3f4f6;--btn-border:#6b343c;--btn-hover:#3b262b;
        --btn-primary-bg:#dc2626;--btn-primary-fg:#ffffff;--btn-primary-border:#ef4444;--btn-primary-hover:#b91c1c;
      }
      .card.warning{
        --bg:#1f1b13;--border:#594218;--accent:#fbbf24;--title:#fde68a;--text:#f3f4f6;--muted:#d1d5db;
        --badge-bg:#382c12;--badge-fg:#fde68a;--pill-bg:#382c12;--pill-fg:#fef3c7;
        --panel-bg:#262117;--panel-border:#594218;
        --btn-bg:#292318;--btn-fg:#f3f4f6;--btn-border:#6b5322;--btn-hover:#382f1e;
        --btn-primary-bg:#d97706;--btn-primary-fg:#111827;--btn-primary-border:#fbbf24;--btn-primary-hover:#b45309;
      }
    }
    @starting-style{.card{opacity:0;translate:0 -10px}}
    @media (prefers-reduced-motion: reduce){
      .card{translate:none;transition-duration:.1s}
      @starting-style{.card{translate:none}}
    }
    .top{display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px 12px}
    .lead{display:flex;align-items:flex-start;gap:10px;flex:1 1 280px;min-width:0}
    .icon-badge{
      flex-shrink:0;width:34px;height:34px;border-radius:8px;
      display:flex;align-items:center;justify-content:center;
      background:var(--badge-bg);color:var(--badge-fg);margin-top:1px;
    }
    .copy{min-width:0;flex:1}
    .headline{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
    .title{font-weight:700;font-size:14.5px;color:var(--title)}
    .pill{
      display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;
      font-size:11.5px;font-weight:600;background:var(--pill-bg);color:var(--pill-fg);
    }
    .reason{margin-top:2px;color:var(--text);font-size:13.5px;overflow-wrap:anywhere}
    .actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-inline-start:auto}
    button{
      font:inherit;font-size:13px;font-weight:500;line-height:1.2;
      border-radius:8px;padding:6px 11px;cursor:pointer;
      border:1px solid var(--btn-border);background:var(--btn-bg);color:var(--btn-fg);
      display:inline-flex;align-items:center;justify-content:center;gap:4px;
      transition:background-color .15s,border-color .15s;
    }
    button:hover:not(:disabled){background:var(--btn-hover)}
    button:disabled{opacity:.55;cursor:default}
    button.btn-primary{
      background:var(--btn-primary-bg);color:var(--btn-primary-fg);border-color:var(--btn-primary-border);font-weight:600;
    }
    button.btn-primary:hover:not(:disabled){background:var(--btn-primary-hover)}
    button.x{padding:6px;border-color:transparent;background:transparent;color:var(--muted)}
    button.x:hover:not(:disabled){background:var(--btn-hover);color:var(--text)}
    button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    details{margin-top:10px;border-top:1px solid var(--panel-border);padding-top:8px}
    summary{
      list-style:none;display:flex;align-items:center;gap:6px;cursor:pointer;
      font-weight:600;font-size:13px;color:var(--title);user-select:none;border-radius:4px;
    }
    summary::-webkit-details-marker{display:none}
    summary::before{
      content:"";inline-size:1em;block-size:1em;flex-shrink:0;background-color:currentColor;
      mask:${CHEVRON_MASK} no-repeat center / contain;
      -webkit-mask:${CHEVRON_MASK} no-repeat center / contain;
      rotate:-90deg;
    }
    details[open] > summary::before{rotate:0deg}
    @media (prefers-reduced-motion: no-preference){
      summary::before{transition:rotate .2s}
      details::details-content{
        transition:block-size,content-visibility,display;
        transition-duration:.22s;transition-timing-function:ease-in-out;
        transition-behavior:allow-discrete;
      }
    }
    details::details-content{interpolate-size:allow-keywords;overflow:clip;contain:layout}
    details:not([open])::details-content{block-size:0}
    ul{margin:8px 0 6px;padding-left:20px;font-size:13px}
    li+li{margin-top:2px}
    .panel{
      margin-top:8px;padding:8px 10px;border-radius:8px;
      background:var(--panel-bg);border:1px solid var(--panel-border);font-size:13px;
    }
    dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0}
    dt{color:var(--muted);font-weight:500}
    dd{margin:0;word-break:break-word;color:var(--text)}
    .it{margin-top:8px;border-top:1px solid var(--panel-border);padding-top:8px}
    .it summary{font-size:12.5px;color:var(--muted)}
    .it dl{margin-top:6px;font-size:12.5px}
    .more{font-size:12px;color:var(--muted);margin-top:2px}
    .copy-it{margin-top:8px;font-size:12.5px;padding:5px 10px}
    @media (forced-colors: active){
      .card{border:2px solid CanvasText;border-inline-start:6px solid CanvasText;background:Canvas;color:CanvasText}
      .icon-badge,.pill,.panel{border:1px solid CanvasText}
      button{border:1px solid ButtonText;background:ButtonFace;color:ButtonText}
      button:focus-visible,summary:focus-visible{outline:2px solid Highlight;outline-offset:2px}
    }`;

  const wrap = doc.createElement('div');
  wrap.className = 'wrap';

  const card = doc.createElement('div');
  card.className = `card ${model.level}`;
  card.setAttribute('role', 'alert');

  const top = doc.createElement('div');
  top.className = 'top';

  const lead = doc.createElement('div');
  lead.className = 'lead';

  const iconBadge = doc.createElement('div');
  iconBadge.className = 'icon-badge';
  iconBadge.append(createStatusIcon(doc, model.level, 20));

  const copy = doc.createElement('div');
  copy.className = 'copy';

  const headline = doc.createElement('div');
  headline.className = 'headline';

  const title = doc.createElement('strong');
  title.className = 'title';
  title.textContent = model.title;
  headline.append(title);

  let lockPill: HTMLSpanElement | undefined;
  if (model.linksLocked) {
    lockPill = doc.createElement('span');
    lockPill.className = 'pill';
    const lockText = doc.createElement('span');
    lockText.textContent = 'Links paused';
    lockPill.append(createLockIcon(doc, 12), lockText);
    headline.append(lockPill);
  }

  const reason = doc.createElement('div');
  reason.className = 'reason';
  reason.textContent = (model.reasons[0] ?? 'Please review before clicking anything').slice(0, 140);

  copy.append(headline, reason);
  lead.append(iconBadge, copy);

  const actionsBar = doc.createElement('div');
  actionsBar.className = 'actions';

  const button = (label: string, onClick: (b: HTMLButtonElement) => void, cls = '') => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', () => onClick(b));
    return b;
  };

  if (model.linksLocked) {
    actionsBar.append(
      button(
        'I trust this email',
        (b) => {
          actions.onUnlock();
          b.disabled = true;
          b.textContent = 'Links enabled';
          if (lockPill) lockPill.textContent = 'Links enabled';
        },
        'btn-primary',
      ),
    );
  }

  const trust = button('Always trust sender', async (b) => {
    b.disabled = true;
    if (await actions.onTrustSender()) {
      actions.onUnlock();
      removeBanner(doc);
    }
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

  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'x';
  close.setAttribute('aria-label', model.linksLocked ? 'Dismiss warning (links stay paused)' : 'Dismiss warning');
  close.append(createCloseIcon(doc, 14));
  close.addEventListener('click', () => {
    actions.onDismiss();
    removeBanner(doc);
  });

  actionsBar.append(trust, report, close);
  top.append(lead, actionsBar);
  card.append(top);

  const details = doc.createElement('details');
  const summary = doc.createElement('summary');
  summary.textContent = 'See why';
  details.append(summary);

  if (model.reasons.length) {
    const ul = doc.createElement('ul');
    for (const r of model.reasons.slice(0, 3)) {
      const li = doc.createElement('li');
      li.textContent = r;
      ul.append(li);
    }
    details.append(ul);
    if (model.reasons.length > 3) {
      const more = doc.createElement('div');
      more.className = 'more';
      more.textContent = `+${model.reasons.length - 3} more in IT options`;
      details.append(more);
    }
  }
  if (model.sender) {
    const panel = doc.createElement('div');
    panel.className = 'panel';
    panel.append(renderSimpleDetails(doc, model.sender, model.intel));
    details.append(panel, renderITDetails(doc, model.sender, model.intel, model.verdict, model.reasons));
  }
  card.append(details);

  wrap.append(card);
  root.append(style, wrap);
  (doc.body ?? doc.documentElement).appendChild(host);
}
