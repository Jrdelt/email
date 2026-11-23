import { intelWarnings } from '../domainIntel';
import type { Verdict } from '../features';
import type { SenderInfo } from '../sender';
import { type IntelState, renderITDetails, renderSimpleDetails } from './details';
import { createCloseIcon, createLockIcon, createStatusIcon } from './icons';

export interface BannerModel {
  level: 'warning' | 'danger';
  title: string;
  tag?: string;
  reasons: string[];
  linksLocked: boolean;
  verdict?: Verdict;
  sender?: SenderInfo;
  intel?: IntelState;
}

export interface BannerActions {
  onUnlock(): void | Promise<void>; // "I trust this email" — unlock links for this email
  onUndoUnlock?(): void | Promise<void>; // revert persistent email trust and re-lock links
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
  const intelList = typeof intel === 'object' ? intelWarnings(intel) : [];
  const senderWarnings = [...sender.warnings, ...intelList];
  if (!danger && senderWarnings.length === 0) return null;
  const reasons = danger ? [...verdict.reasons, ...senderWarnings] : [...senderWarnings, ...verdict.reasons];
  const title = danger
    ? verdict.level === 'likely-phishing'
      ? 'Possible phishing.'
      : 'Looks suspicious.'
    : 'Check this sender.';
  const tag = danger ? 'PHISHING WARNING' : intelList.length > 0 ? 'DOMAIN WARNING' : 'SENDER WARNING';
  return {
    level: danger ? 'danger' : 'warning',
    title,
    tag,
    reasons,
    linksLocked: !unlockedThisSession,
    verdict,
    sender,
    intel,
  };
}

/** Renders the neo-brutalist warning card inside a closed shadow root. textContent only. */
export function showBanner(model: BannerModel, actions: BannerActions, doc: Document = document): void {
  removeBanner(doc);
  const host = doc.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = `
    :host{all:initial!important;display:block!important;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif!important;color:#111111!important;font-size:14px!important;line-height:1.4!important;direction:ltr!important;text-align:left!important;visibility:visible!important;opacity:1!important}
    .wrap{position:fixed;top:22px;left:16px;right:16px;z-index:2147483647;display:flex;justify-content:center;pointer-events:none}
    .card{
      pointer-events:auto;position:relative;width:100%;max-width:760px;box-sizing:border-box;
      background:#ffffff;color:#111111;border:2px solid #111111;border-radius:16px;
      box-shadow:6px 6px 0 #111111;padding:20px 22px 18px;font-size:14px;line-height:1.4;
      opacity:1;translate:0;
      transition:opacity .2s ease-out,translate .2s ease-out;
    }
    @starting-style{.card{opacity:0;translate:0 -10px}}
    @media (prefers-reduced-motion: reduce){
      .card{translate:none;transition-duration:.1s}
      @starting-style{.card{translate:none}}
    }
    .sticker-top{
      position:absolute;top:-15px;right:44px;rotate:4deg;
      background:#26d08c;color:#111111;border:2px solid #111111;border-radius:999px;
      box-shadow:3px 3px 0 #111111;padding:4px 16px;
      font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
      pointer-events:none;
    }
    .x{
      position:absolute;top:14px;right:14px;width:30px;height:30px;padding:0;
      border-radius:50%;background:#ffffff;color:#111111;border:2px solid #111111;
      display:inline-flex;align-items:center;justify-content:center;cursor:pointer;
    }
    .x:hover{background:#fdf9f0}
    .main-row{display:flex;align-items:flex-start;gap:14px;padding-right:36px}
    .icon-box{
      flex-shrink:0;width:44px;height:44px;border-radius:10px;
      background:#ff563f;color:#111111;border:2px solid #111111;
      box-shadow:3px 3px 0 #111111;display:flex;align-items:center;justify-content:center;margin-top:2px;
    }
    .copy{flex:1 1 260px;min-width:0}
    .title{font-size:24px;font-weight:900;letter-spacing:-.03em;line-height:1.08;color:#111111}
    .tag{
      display:inline-block;margin:6px 0 8px;background:#111111;color:#ffffff;border-radius:999px;
      font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;padding:3px 12px;
    }
    .reason{font-weight:700;font-size:14px;color:#111111;overflow-wrap:anywhere}
    .compare{margin-top:4px;font-size:12.5px;font-weight:600;color:#333333;overflow-wrap:anywhere}
    .sub{font-size:13.5px;color:#444444;margin-top:2px}
    .sticker-side{
      align-self:center;flex-shrink:0;display:inline-flex;align-items:center;gap:5px;
      background:#ffa8c6;color:#111111;border:2px solid #111111;border-radius:999px;
      box-shadow:3px 3px 0 #111111;rotate:-6deg;
      font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:6px 15px;margin-top:10px;
    }
    .actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:14px;margin-left:58px}
    button.btn{
      font:inherit;font-size:13px;font-weight:700;line-height:1.2;
      border-radius:10px;padding:7px 14px;cursor:pointer;
      border:2px solid #111111;box-shadow:3px 3px 0 #111111;
      background:#ffffff;color:#111111;
      display:inline-flex;align-items:center;justify-content:center;gap:5px;
      transition:translate .1s,box-shadow .1s,background-color .1s;
    }
    button.btn-mint{background:#26d08c}
    button.btn-danger{background:#ff563f}
    button.btn:hover:not(:disabled){translate:-1px -1px;box-shadow:4px 4px 0 #111111}
    button.btn:active:not(:disabled){translate:2px 2px;box-shadow:1px 1px 0 #111111}
    button.btn:disabled{opacity:.55;cursor:default}
    button:focus-visible,summary:focus-visible{outline:2px solid #111111;outline-offset:2px}
    .confirm-bar{
      margin-top:12px;margin-left:58px;padding:10px 12px;border-radius:12px;
      background:#fdf9f0;border:2px solid #111111;display:grid;gap:8px;
    }
    .confirm-bar[hidden]{display:none}
    .confirm-msg{font-size:13px;font-weight:700;color:#111111}
    .confirm-actions{display:flex;flex-wrap:wrap;gap:8px}
    .card.trusted-pill{
      width:auto;max-width:460px;padding:10px 14px;border-radius:999px;
      display:flex;align-items:center;gap:10px;background:#ffffff;
    }
    .pill-text{font-weight:800;font-size:13.5px;color:#111111}
    button.pill-btn{padding:4px 10px;font-size:12px;border-radius:999px;background:#26d08c}
    .pill-x{
      width:24px;height:24px;padding:0;border-radius:50%;background:#ffffff;color:#111111;
      border:2px solid #111111;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;
    }
    .pill-x:hover{background:#fdf9f0}
    .drawer{
      margin-top:14px;margin-left:58px;background:#fdf9f0;border:2px solid #111111;
      border-radius:12px;padding:12px 14px;max-height:45vh;overflow:auto;font-size:13px;
    }
    .drawer[hidden]{display:none}
    ul{margin:0 0 8px;padding-left:18px}
    li+li{margin-top:2px}
    .more{font-size:12px;color:#444444;margin-bottom:8px}
    dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0}
    dt{color:#444444;font-weight:700}
    dd{margin:0;word-break:break-word;color:#111111}
    details.it{margin-top:10px;border-top:2px solid #111111;padding-top:8px}
    summary{
      list-style:none;display:flex;align-items:center;gap:6px;cursor:pointer;
      font-weight:800;font-size:12.5px;color:#111111;user-select:none;border-radius:4px;
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
    .it dl{margin-top:8px;font-size:12.5px}
    .copy-it{
      margin-top:10px;font:inherit;font-size:12.5px;font-weight:700;
      padding:6px 12px;border-radius:8px;border:2px solid #111111;
      background:#26d08c;color:#111111;box-shadow:2px 2px 0 #111111;cursor:pointer;
    }
    @media (max-width: 600px){
      .sticker-side{display:none}
      .actions,.drawer,.confirm-bar{margin-left:0}
      .title{font-size:20px}
    }
    @media (forced-colors: active){
      .card,.sticker-top,.sticker-side,.icon-box,.drawer,.confirm-bar,.x,.pill-x,button.btn,.copy-it{box-shadow:none;border:2px solid CanvasText;background:Canvas;color:CanvasText}
      .tag{border:1px solid CanvasText}
      button:focus-visible,summary:focus-visible{outline:2px solid Highlight;outline-offset:2px}
    }`;

  const wrap = doc.createElement('div');
  wrap.className = 'wrap';

  const card = doc.createElement('div');
  card.className = `card ${model.level}`;
  card.setAttribute('role', 'alert');

  const topSticker = doc.createElement('div');
  topSticker.className = 'sticker-top';
  topSticker.setAttribute('aria-hidden', 'true');
  topSticker.textContent = model.level === 'danger' ? 'PHISHING ALERT' : 'SENDER CHECK';

  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'x';
  close.setAttribute('aria-label', model.linksLocked ? 'Dismiss warning (links stay paused)' : 'Dismiss warning');
  close.append(createCloseIcon(doc, 14));
  close.addEventListener('click', () => {
    actions.onDismiss();
    removeBanner(doc);
  });

  const mainRow = doc.createElement('div');
  mainRow.className = 'main-row';

  const iconBox = doc.createElement('div');
  iconBox.className = 'icon-box';
  iconBox.append(createStatusIcon(doc, model.level, 24));

  const copy = doc.createElement('div');
  copy.className = 'copy';

  const title = doc.createElement('div');
  title.className = 'title';
  title.textContent = model.title;

  const tag = doc.createElement('span');
  tag.className = 'tag';
  tag.textContent = model.tag ?? (model.level === 'danger' ? 'PHISHING WARNING' : 'SENDER WARNING');

  const reason = doc.createElement('div');
  reason.className = 'reason';
  reason.textContent = (model.reasons[0] ?? 'Check the details before clicking.').slice(0, 140);

  const sub = doc.createElement('div');
  sub.className = 'sub';
  sub.textContent = model.linksLocked
    ? 'Links are paused. Verify the sender before trusting links or attachments.'
    : 'Verify the sender before trusting links or attachments.';

  copy.append(title, tag, reason);
  if (model.sender && (model.sender.rawAddress || model.sender.linkDomains.length > 0)) {
    const parts: string[] = [];
    if (model.sender.rawAddress) parts.push(`From: ${model.sender.rawAddress}`);
    if (model.sender.linkDomains.length > 0) {
      const doms = model.sender.linkDomains;
      parts.push(`Links go to: ${doms.slice(0, 2).join(', ')}${doms.length > 2 ? ` (+${doms.length - 2})` : ''}`);
    }
    const compare = doc.createElement('div');
    compare.className = 'compare';
    compare.textContent = parts.join('  •  ');
    copy.append(compare);
  }
  copy.append(sub);

  const sideSticker = doc.createElement('div');
  sideSticker.className = 'sticker-side';
  const sideLabel = doc.createElement('span');
  if (model.linksLocked) {
    sideLabel.textContent = 'LINKS PAUSED!';
    sideSticker.append(createLockIcon(doc, 12), sideLabel);
  } else {
    sideLabel.textContent = 'DOUBLE-CHECK!';
    sideSticker.append(sideLabel);
  }

  mainRow.append(iconBox, copy, sideSticker);

  const drawer = doc.createElement('div');
  drawer.className = 'drawer';
  drawer.hidden = true;

  if (model.reasons.length) {
    const ul = doc.createElement('ul');
    for (const r of model.reasons.slice(0, 3)) {
      const li = doc.createElement('li');
      li.textContent = r;
      ul.append(li);
    }
    drawer.append(ul);
    if (model.reasons.length > 3) {
      const more = doc.createElement('div');
      more.className = 'more';
      more.textContent = `+${model.reasons.length - 3} more in IT options`;
      drawer.append(more);
    }
  }
  if (model.sender) {
    drawer.append(
      renderSimpleDetails(doc, model.sender, model.intel),
      renderITDetails(doc, model.sender, model.intel, model.verdict, model.reasons),
    );
  }

  const actionsBar = doc.createElement('div');
  actionsBar.className = 'actions';

  const button = (label: string, onClick: (b: HTMLButtonElement) => void, extraClass = '') => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = extraClass ? `btn ${extraClass}` : 'btn';
    b.textContent = label;
    b.addEventListener('click', () => onClick(b));
    return b;
  };

  const seeWhy = button(
    'See why ↗',
    (b) => {
      drawer.hidden = !drawer.hidden;
      const open = !drawer.hidden;
      b.setAttribute('aria-expanded', String(open));
      b.textContent = open ? 'Hide details ↑' : 'See why ↗';
    },
    'btn-mint',
  );
  seeWhy.setAttribute('aria-expanded', 'false');

  const report = button('Not phishing', async (b) => {
    b.disabled = true;
    await actions.onReport();
    b.textContent = 'Reported (saved)';
  });

  const trust = button('Always trust sender', async (b) => {
    b.disabled = true;
    if (await actions.onTrustSender()) {
      removeBanner(doc);
    }
  });
  if (!model.sender?.valid) {
    trust.disabled = true;
    trust.title = "Sender address couldn't be verified";
  }

  actionsBar.append(seeWhy, report, trust);

  const renderTrustedPill = () => {
    card.textContent = '';
    card.className = 'card trusted-pill';
    card.setAttribute('role', 'status');
    const label = doc.createElement('span');
    label.className = 'pill-text';
    label.textContent = 'Email trusted — links enabled';
    card.append(createStatusIcon(doc, 'safe', 18), label);
    if (actions.onUndoUnlock) {
      card.append(
        button(
          'Undo',
          async (u) => {
            u.disabled = true;
            await actions.onUndoUnlock?.();
          },
          'pill-btn',
        ),
      );
    }
    const dismiss = doc.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'pill-x';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.append(createCloseIcon(doc, 12));
    dismiss.addEventListener('click', () => removeBanner(doc));
    card.append(dismiss);
  };

  let confirmBar: HTMLDivElement | undefined;
  if (model.linksLocked) {
    if (model.level === 'warning') {
      actionsBar.append(
        button('I trust this email', async (b) => {
          b.disabled = true;
          await actions.onUnlock();
          renderTrustedPill();
        }),
      );
    } else {
      confirmBar = doc.createElement('div');
      confirmBar.className = 'confirm-bar';
      confirmBar.hidden = true;

      const confirmMsg = doc.createElement('div');
      confirmMsg.className = 'confirm-msg';
      confirmMsg.textContent = 'Links in this email look dangerous. Only unlock if you verified the sender.';

      const confirmActions = doc.createElement('div');
      confirmActions.className = 'confirm-actions';

      let triggerBtn!: HTMLButtonElement;
      const keepSafe = button(
        'Keep links paused',
        () => {
          confirmBar!.hidden = true;
          triggerBtn.setAttribute('aria-expanded', 'false');
          triggerBtn.focus();
        },
        'btn-mint',
      );
      const confirmUnlock = button(
        'Yes, unlock links anyway',
        async (b) => {
          b.disabled = true;
          keepSafe.disabled = true;
          await actions.onUnlock();
          renderTrustedPill();
        },
        'btn-danger',
      );
      confirmActions.append(keepSafe, confirmUnlock);
      confirmBar.append(confirmMsg, confirmActions);

      triggerBtn = button('I trust this email', (b) => {
        const nextOpen = confirmBar!.hidden;
        confirmBar!.hidden = !nextOpen;
        b.setAttribute('aria-expanded', String(nextOpen));
      });
      triggerBtn.setAttribute('aria-expanded', 'false');
      actionsBar.append(triggerBtn);
    }
  }

  if (confirmBar) card.append(topSticker, close, mainRow, actionsBar, confirmBar, drawer);
  else card.append(topSticker, close, mainRow, actionsBar, drawer);
  wrap.append(card);
  root.append(style, wrap);
  (doc.documentElement ?? doc.body).appendChild(host);
}
