import { createCloseIcon, createLockIcon } from './icons';

const TOAST_HOST_ID = 'ped-toast-host';
const AUTO_DISMISS_MS = 5500;

interface ToastController {
  host: HTMLElement;
  toast: HTMLElement;
  msgEl: HTMLElement;
  liveEl: HTMLElement;
  timer?: ReturnType<typeof setTimeout>;
  hovered: boolean;
  trigger: HTMLElement | null;
  hide: (returnFocus?: boolean) => void;
}

const controllers = new WeakMap<Document, ToastController>();

function clearTimer(c: ToastController) {
  if (c.timer !== undefined) {
    clearTimeout(c.timer);
    c.timer = undefined;
  }
}

function armTimer(c: ToastController) {
  clearTimer(c);
  if (c.hovered || c.toast.matches(':focus-within')) return;
  c.timer = setTimeout(() => {
    if (!c.hovered && !c.toast.matches(':focus-within')) c.hide(false);
  }, AUTO_DISMISS_MS);
}

function ensureToast(doc: Document): ToastController {
  const existing = controllers.get(doc);
  if (existing && existing.host.isConnected) return existing;

  doc.getElementById(TOAST_HOST_ID)?.remove();

  const host = doc.createElement('div');
  host.id = TOAST_HOST_ID;
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = `
    :host{all:initial!important;display:block!important;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif!important;color:#111111!important;font-size:13px!important;line-height:1.35!important}
    .sr-only{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip-path:inset(50%)!important;white-space:nowrap!important}
    .toast{
      display:none;align-items:center;gap:10px;box-sizing:border-box;
      width:max-content;max-width:min(520px,calc(100vw - 24px));
      position:fixed;inset:auto auto 20px 50%;translate:-50% 8px;margin:0;
      background:#ffffff;color:#111111;border:2px solid #111111;border-radius:12px;
      box-shadow:4px 4px 0 #111111;padding:10px 12px;font-size:13px;font-weight:700;line-height:1.35;
      z-index:2147483647;opacity:0;
    }
    .toast:is(:popover-open,.open){display:flex;opacity:1;translate:-50% 0}
    @media (prefers-reduced-motion: no-preference){
      .toast{
        transition:opacity .18s ease-out,translate .18s ease-out,display .18s ease-out,overlay .18s ease-out;
        transition-behavior:allow-discrete;
      }
      @starting-style{.toast:is(:popover-open,.open){opacity:0;translate:-50% 10px}}
    }
    .badge{
      flex-shrink:0;width:28px;height:28px;border-radius:8px;
      background:#ff563f;color:#111111;border:2px solid #111111;
      display:inline-flex;align-items:center;justify-content:center;
    }
    .msg{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
    .close{
      flex-shrink:0;width:28px;height:28px;padding:0;border-radius:50%;
      background:#ffffff;color:#111111;border:2px solid #111111;
      display:inline-flex;align-items:center;justify-content:center;cursor:pointer;
    }
    .close:hover{background:#fdf9f0}
    .close:focus-visible{outline:2px solid #111111;outline-offset:2px}
    @media (max-width: 360px){
      .toast{max-width:calc(100vw - 16px);padding:8px 10px;gap:8px;font-size:12.5px}
    }
    @media (forced-colors: active){
      .toast,.badge,.close{box-shadow:none;border:2px solid CanvasText;background:Canvas;color:CanvasText}
      .close:focus-visible{outline:2px solid Highlight;outline-offset:2px}
    }`;

  const region = doc.createElement('div');
  region.setAttribute('role', 'region');
  region.setAttribute('aria-label', 'Link safety notifications');

  const liveEl = doc.createElement('div');
  liveEl.className = 'sr-only';
  liveEl.setAttribute('aria-live', 'polite');
  liveEl.setAttribute('aria-atomic', 'true');

  const toast = doc.createElement('div');
  toast.id = 'ped-toast';
  toast.className = 'toast';
  toast.setAttribute('popover', 'manual');

  const badge = doc.createElement('span');
  badge.className = 'badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.append(createLockIcon(doc, 14));

  const msgEl = doc.createElement('span');
  msgEl.className = 'msg';

  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'close';
  close.setAttribute('popovertarget', 'ped-toast');
  close.setAttribute('popovertargetaction', 'hide');
  close.setAttribute('aria-label', 'Dismiss notification');
  close.append(createCloseIcon(doc, 12));

  toast.append(badge, msgEl, close);
  region.append(liveEl, toast);
  root.append(style, region);
  (doc.documentElement ?? doc.body).appendChild(host);

  const ctrl: ToastController = {
    host,
    toast,
    msgEl,
    liveEl,
    hovered: false,
    trigger: null,
    hide: (returnFocus = false) => {
      clearTimer(ctrl);
      const focusInside = root.activeElement !== null || toast.matches(':focus-within');
      toast.classList.remove('open');
      const pop = toast as HTMLElement & { hidePopover?: () => void };
      if (typeof pop.hidePopover === 'function') {
        try { pop.hidePopover(); } catch { /* ignore if not open */ }
      }
      if (returnFocus && focusInside && ctrl.trigger?.isConnected) {
        ctrl.trigger.focus();
      }
    },
  };

  close.addEventListener('click', () => ctrl.hide(true));
  toast.addEventListener('mouseenter', () => {
    ctrl.hovered = true;
    clearTimer(ctrl);
  });
  toast.addEventListener('mouseleave', () => {
    ctrl.hovered = false;
    armTimer(ctrl);
  });
  toast.addEventListener('focusin', () => clearTimer(ctrl));
  toast.addEventListener('focusout', () => armTimer(ctrl));

  controllers.set(doc, ctrl);
  return ctrl;
}

function presentToast(doc: Document, message: string, trigger: HTMLElement | null): void {
  if (!doc.documentElement && !doc.body) return;
  const ctrl = ensureToast(doc);
  ctrl.trigger = trigger;

  ctrl.msgEl.textContent = message;

  ctrl.toast.classList.add('open');
  const pop = ctrl.toast as HTMLElement & { showPopover?: () => void };
  if (typeof pop.showPopover === 'function') {
    try { pop.showPopover(); } catch { /* ignore if already open or detached */ }
  }

  const ariaDoc = doc as Document & { ariaNotify?: (msg: string) => void };
  if (typeof ariaDoc.ariaNotify === 'function') {
    ariaDoc.ariaNotify(message);
  } else {
    ctrl.liveEl.textContent = '';
    ctrl.liveEl.textContent = message;
  }

  armTimer(ctrl);
}

/** Shows a non-intrusive toast explaining why a paused link click was blocked. */
export function showPausedLinkToast(doc: Document, host: string, trigger: HTMLElement | null = null): void {
  const message = host
    ? `Link paused for safety — goes to ${host}. Use the warning banner above to review or unlock.`
    : 'Action paused for safety. Use the warning banner above to review or unlock.';
  presentToast(doc, message, trigger);
}

/** Shows a non-intrusive toast explaining why an untrusted attachment click was blocked. */
export function showPausedAttachmentToast(doc: Document, filename: string, trigger: HTMLElement | null = null): void {
  const message = filename
    ? `Attachment blocked (${filename}) — untrusted emails cannot open attachments. Trust this email or sender in the banner above.`
    : 'Attachment blocked — untrusted emails cannot open attachments. Trust this email or sender in the banner above.';
  presentToast(doc, message, trigger);
}

export function removePausedLinkToast(doc: Document = document): void {
  const ctrl = controllers.get(doc);
  if (ctrl) {
    ctrl.hide(false);
    ctrl.host.remove();
    controllers.delete(doc);
  } else {
    doc.getElementById(TOAST_HOST_ID)?.remove();
  }
}
