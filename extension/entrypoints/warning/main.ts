import { ageDays, type DomainIntel } from '../../src/domainIntel';
import { destinationIntelWarnings, isSafeHttpUrl } from '../../src/linkGuard';
import { formatAge } from '../../src/ui/details';
import { createLogoSvg, createStatusIcon } from '../../src/ui/icons';

interface StoredWarning {
  href: string;
  host: string;
  registrable: string;
  level: 'warning' | 'danger';
  reasons: string[];
  senderAddress?: string;
  intel?: DomainIntel;
  createdAt?: number;
}

const $ = (id: string) => document.getElementById(id)!;

$('logo').append(createLogoSvg(document, 32));

function closeOrBack() {
  window.close();
  if (history.length > 1) history.back();
}

$('back-btn').addEventListener('click', closeOrBack);

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
    if (intel.rdap.registrar) parts.push(`Registrar: ${intel.rdap.registrar}`);
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

function renderHelpMode() {
  document.title = 'Clicked a Suspicious Link? — Phishing Email Detector';
  $('sticker').textContent = 'RECOVERY GUIDE';
  $('sticker').classList.add('safe');
  $('icon-box').classList.add('safe');
  $('icon-box').append(createStatusIcon(document, 'safe', 24));
  $('title').textContent = 'Clicked a suspicious link? Stay calm.';
  $('lead').textContent = 'Follow the steps below based on what actually happened after you clicked.';
  ($('recovery-details') as HTMLDetailsElement).open = true;
}

function renderExpiredMode() {
  $('sticker').textContent = 'LINK EXPIRED';
  $('icon-box').append(createStatusIcon(document, 'warning', 24));
  $('title').textContent = 'This warning link has expired';
  $('lead').textContent = 'Temporary link warnings are cleared when you close your browser. Review the steps below if you already visited a suspicious site.';
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
  const stored = (await browser.storage.session?.get?.(key))?.[key] as StoredWarning | undefined;
  if (!stored || !isSafeHttpUrl(stored.href)) {
    renderExpiredMode();
    return;
  }

  const card = $('alert-card');
  card.setAttribute('role', 'alert');

  const kind = stored.level === 'warning' ? 'warning' : 'danger';
  $('icon-box').append(createStatusIcon(document, kind, 24));
  $('sticker').textContent = kind === 'danger' ? 'PHISHING RISK' : 'CHECK LINK';
  $('title').textContent = kind === 'danger' ? 'Dangerous link stopped' : 'Check where this link goes';
  $('lead').textContent =
    kind === 'danger'
      ? 'Opening this link could expose your passwords, accounts, or device.'
      : 'This link hides or weakens the destination address. Confirm where it goes before continuing.';

  $('dest-box').hidden = false;
  $('dest-host').textContent = stored.host || stored.registrable || 'Unknown destination';
  $('dest-url').textContent = stored.href;

  const reasons = [...stored.reasons];
  renderReasons(reasons);

  if (stored.intel) {
    $('dest-meta').textContent = describeDestIntel(stored.intel);
  } else if (stored.registrable) {
    $('dest-meta').textContent = `Checking ${stored.registrable}…`;
    try {
      const intel = (await browser.runtime.sendMessage({
        type: 'domainIntel',
        domain: stored.registrable,
      })) as DomainIntel | undefined;
      if (intel && typeof intel === 'object') {
        $('dest-meta').textContent = describeDestIntel(intel) || 'Domain details checked.';
        const extra = destinationIntelWarnings(intel);
        if (extra.length) {
          renderReasons([...new Set([...reasons, ...extra])]);
          $('sticker').textContent = 'PHISHING RISK';
          $('title').textContent = 'Dangerous link stopped';
        }
      } else {
        $('dest-meta').textContent = '';
      }
    } catch {
      $('dest-meta').textContent = '';
    }
  }

  const adv = $('advanced-details') as HTMLDetailsElement;
  adv.hidden = false;
  const proceed = $('proceed-btn');
  proceed.textContent = `I understand the risk — open ${stored.host || 'link'}`;
  proceed.addEventListener('click', async () => {
    if (!isSafeHttpUrl(stored.href)) return;
    await browser.storage.session?.remove?.(key).catch(() => {});
    location.replace(stored.href);
  });

  $('back-btn').focus();
}

void init();
