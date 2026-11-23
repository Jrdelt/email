import { listTrusted, untrustSender } from '../../src/allowlist';
import { intelWarnings } from '../../src/domainIntel';
import type { Verdict } from '../../src/features';
import { clearReports, listReports } from '../../src/feedback';
import type { SenderInfo } from '../../src/sender';
import { type IntelState, renderITDetailsContent, renderSimpleDetails } from '../../src/ui/details';
import { createLogoSvg, createStatusIcon } from '../../src/ui/icons';

const kv = browser.storage.local;
const $ = (id: string) => document.getElementById(id)!;

interface TabState { verdict: Verdict; sender?: SenderInfo; intel?: IntelState }

$('logo').append(createLogoSvg(document, 28));

async function renderVerdict() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  const key = `tab:${tab.id}`;
  const st = (await browser.storage.session?.get?.(key))?.[key] as TabState | undefined;
  if (!st?.verdict) return;

  const senderWarnings = [
    ...(st.sender?.warnings ?? []),
    ...(typeof st.intel === 'object' ? intelWarnings(st.intel) : []),
  ];
  const danger = st.verdict.level !== 'safe';
  const allReasons = danger
    ? [...st.verdict.reasons, ...senderWarnings]
    : [...senderWarnings, ...st.verdict.reasons];

  const out = $('out');
  out.textContent = '';
  out.className = 'card';

  const badge = document.createElement('div');
  let kind: 'safe' | 'warning' | 'danger' = 'safe';
  let label = 'Looks safe';
  if (st.verdict.level === 'likely-phishing') {
    kind = 'danger';
    label = 'Possible phishing email';
    badge.className = 'status status-danger';
  } else if (st.verdict.level === 'suspicious') {
    kind = 'danger';
    label = 'This email looks suspicious';
    badge.className = 'status status-danger';
  } else if (senderWarnings.length > 0) {
    kind = 'warning';
    label = 'Double-check this sender';
    badge.className = 'status status-warn';
  } else {
    badge.className = 'status status-safe';
  }
  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  badge.append(createStatusIcon(document, kind, 16), labelSpan);
  out.append(badge);

  if ((danger || senderWarnings.length > 0) && allReasons.length > 0) {
    const ul = document.createElement('ul');
    for (const r of allReasons.slice(0, 3)) {
      const li = document.createElement('li');
      li.textContent = r;
      ul.append(li);
    }
    out.append(ul);
  }

  if (st.sender) {
    out.append(renderSimpleDetails(document, st.sender, st.intel));
    const itDetails = $('it-details');
    itDetails.textContent = '';
    itDetails.className = 'card';
    itDetails.append(renderITDetailsContent(document, st.sender, st.intel, st.verdict, allReasons));
  }
}

async function renderTrusted() {
  const ul = $('trusted');
  ul.textContent = '';
  const list = await listTrusted(kv);
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'None';
    ul.append(li);
    return;
  }
  for (const s of list) {
    const li = document.createElement('li');
    li.className = 'trusted-pill';
    const addr = document.createElement('span');
    addr.textContent = s;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Remove';
    b.addEventListener('click', async () => { await untrustSender(kv, s); await renderTrusted(); });
    li.append(addr, b);
    ul.append(li);
  }
}

async function renderReports() {
  $('reports').textContent = String((await listReports(kv)).length);
}

$('clear').addEventListener('click', async () => { await clearReports(kv); await renderReports(); });
void Promise.all([renderVerdict(), renderTrusted(), renderReports()]);
