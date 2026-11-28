import { ageDays, type DomainIntel } from '../../src/domainIntel';
import { WARN_TTL_MS, destinationIntelWarnings, isSafeHttpUrl, proceedTarget } from '../../src/linkGuard';
import { getSettings } from '../../src/settings';
import { ellipsizeMiddle, showable } from '../../src/text';
import { formatAge } from '../../src/ui/details';
import { createLogoSvg, createStatusIcon } from '../../src/ui/icons';

interface StoredWarning {
  href: string;
  /** The clicked enterprise link-protection URL that leads to `href`; never shown (Safe Links data= can name the recipient). */
  via?: string;
  host: string;
  registrable: string;
  level: 'warning' | 'danger';
  reasons: string[];
  intel?: DomainIntel;
  createdAt?: number;
}


const $ = (id: string) => document.getElementById(id)!;
let warnKey: string | null = null; // session entry holding the clicked URL; removed when the user backs out

$('logo').append(createLogoSvg(document, 32));

async function closeOrBack() {
  if (warnKey) await browser.storage.session?.remove?.(warnKey)?.catch(() => {});
  try {
    const tab = await browser.tabs?.getCurrent?.();
    if (tab?.id !== undefined) {
      await browser.tabs.remove(tab.id);
      return;
    }
  } catch {
    // Fall back to window.close / history.back when tabs API is unavailable.
  }
  window.close();
  if (history.length > 1) history.back();
}

$('back-btn').addEventListener('click', () => {
  void closeOrBack();
});

function renderReasons(list: string[]) {
  const ul = $('reasons');
  ul.textContent = '';
  if (list.length === 0) {
    ul.hidden = true;
    return;
  }
  for (const r of list) {
    const li = document.createElement('li');
    li.textContent = r;
    ul.append(li);
  }
  ul.hidden = false;
}

function describeDestIntel(intel: DomainIntel): string {
  const parts: string[] = [];
  if (intel.rdap.status === 'ok') {
    const age = formatAge(ageDays(intel.rdap.registered));
    if (age) parts.push(`Registered ${age}`);
    if (intel.rdap.registrar) parts.push(`Registrar: ${showable(ellipsizeMiddle(intel.rdap.registrar, 80))}`);
  } else if (intel.dns.status === 'ok' && intel.dns.nxdomain) {
    parts.push('Domain does not exist (NXDOMAIN)');
  } else if (intel.rdap.status === 'notfound') {
    parts.push('Domain not registered');
  }
  if (intel.reputation.status === 'ok') {
    parts.push(intel.reputation.listed.length ? 'Reported for spam/phishing online' : 'Not listed on URIBL');
  }
  return parts.join(' • ');
}

function applyAlertSeverity(kind: 'warning' | 'danger') {
  document.title =
    kind === 'danger' ? 'Dangerous Link Stopped — Phishing Email Detector' : 'Check Link — Phishing Email Detector';
  const sticker = $('sticker');
  sticker.className = `sticker ${kind}`;
  sticker.textContent = kind === 'danger' ? 'PHISHING RISK' : 'CHECK LINK';
  const iconBox = $('icon-box');
  iconBox.className = kind === 'warning' ? 'icon-box warning' : 'icon-box';
  iconBox.replaceChildren(createStatusIcon(document, kind, 24));
  $('title').textContent = kind === 'danger' ? 'Dangerous link stopped' : 'Check where this link goes';
  $('lead').textContent =
    kind === 'danger'
      ? 'Opening this link could expose your passwords, accounts, or device.'
      : 'This link hides or weakens the destination address. Confirm where it goes before continuing.';
}

function renderHelpMode() {
  document.title = 'Clicked a Suspicious Link? — Phishing Email Detector';
  $('sticker').textContent = 'RECOVERY GUIDE';
  $('sticker').className = 'sticker safe';
  $('icon-box').className = 'icon-box safe';
  $('icon-box').replaceChildren(createStatusIcon(document, 'safe', 24));
  $('title').textContent = 'Clicked a suspicious link? Stay calm.';
  $('lead').textContent = 'Follow the steps below based on what actually happened after you clicked.';
  $('back-btn').textContent = 'Close recovery guide';
  ($('recovery-details') as HTMLDetailsElement).open = true;
}

function renderExpiredMode() {
  document.title = 'Warning Expired — Phishing Email Detector';
  $('sticker').textContent = 'LINK EXPIRED';
  $('sticker').className = 'sticker warning';
  $('icon-box').className = 'icon-box warning';
  $('icon-box').replaceChildren(createStatusIcon(document, 'warning', 24));
  $('title').textContent = 'This warning link has expired';
  $('lead').textContent =
    'Temporary link warnings expire after an hour or when you close your browser. Review the steps below if you already visited a suspicious site.';
  ($('recovery-details') as HTMLDetailsElement).open = true;
}

async function init() {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode');
  const id = params.get('id');

  if (mode === 'help' || !id) {
    if (mode === 'help') renderHelpMode();
    else renderExpiredMode();
    return;
  }

  const key = `warn:${id}`;
  warnKey = key;
  const stored = (await browser.storage.session?.get?.(key))?.[key] as StoredWarning | undefined;
  const expired = typeof stored?.createdAt === 'number' && Date.now() - stored.createdAt > WARN_TTL_MS;
  if (!stored || expired || !isSafeHttpUrl(stored.href)) {
    if (expired) await browser.storage.session?.remove?.(key).catch(() => {});
    renderExpiredMode();
    return;
  }

  const card = $('alert-card');
  card.setAttribute('role', 'alert');

  const kind = stored.level === 'warning' ? 'warning' : 'danger';
  applyAlertSeverity(kind);

  $('dest-box').hidden = false;
  // The site is the registrable domain: "www.paypal.com.account-review.example" is account-review.example, which the
  // full host name alone lets read as PayPal. The full host name follows, smaller.
  const site = stored.registrable || stored.host;
  $('dest-host').textContent = site || 'Unknown destination';
  if (stored.host && stored.registrable && stored.host !== stored.registrable) {
    $('dest-fullhost').textContent = `Full host name: ${stored.host}`;
    $('dest-fullhost').hidden = false;
  }
  // The URL as it is navigated to. The stored href is the string unwrapRedirect() returned, which percent-decodes a
  // wrapper's inner target, so it can hold a raw U+202E that reverses the rest of the line ("evil.example/\u202emoc.
  // lapyap.www//:sptth" reads ".../https://www.paypal.com"). The serialisation percent-encodes every non-ASCII
  // character (a host holding one does not parse), so nothing in it can reorder the text.
  $('dest-url').textContent = new URL(stored.href).href;

  const reasons = [...stored.reasons];
  renderReasons(reasons);

  if (stored.intel) {
    $('dest-meta').textContent = describeDestIntel(stored.intel);
  } else if (stored.registrable) {
    const settings = await getSettings(browser.storage.local, browser.storage.managed);
    if (settings.strictLocalMode) {
      $('dest-meta').textContent = 'Domain lookup skipped (Strict Local Mode).';
    } else {
      $('dest-meta').textContent = `Checking ${stored.registrable}…`;
      try {
        const intel = (await browser.runtime.sendMessage({
          type: 'domainIntel',
          domain: stored.registrable,
        })) as DomainIntel | null | undefined;
        if (intel && typeof intel === 'object') {
          $('dest-meta').textContent = describeDestIntel(intel) || 'Domain details checked.';
          const extra = destinationIntelWarnings(intel);
          if (extra.length) {
            renderReasons([...new Set([...reasons, ...extra])]);
            applyAlertSeverity('danger');
          }
        } else if (intel === null) {
          $('dest-meta').textContent = 'Domain lookup skipped (Strict Local Mode).';
        } else {
          $('dest-meta').textContent = '';
        }
      } catch {
        $('dest-meta').textContent = '';
      }
    }
  }

  const adv = $('advanced-details') as HTMLDetailsElement;
  adv.hidden = false;
  const proceed = $('proceed-btn');
  proceed.textContent = `I understand the risk — open ${site || 'link'}`;
  // Through the organisation's link protection when the email's link went through it, so its time-of-click check,
  // block page and click log are not skipped (proceedTarget checks again that it leads exactly to the shown address).
  const target = proceedTarget(stored.href, stored.via);
  if (target !== stored.href) proceed.title = "Opens through your organisation's link protection";
  proceed.addEventListener('click', async () => {
    if (!isSafeHttpUrl(stored.href) || !isSafeHttpUrl(target)) return;
    await browser.storage.session?.remove?.(key).catch(() => {});
    location.replace(target);
  });

  $('back-btn').focus();
}

void init();
