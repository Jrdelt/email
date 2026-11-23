import { listTrusted, untrustSender } from '../../src/allowlist';
import { intelWarnings } from '../../src/domainIntel';
import type { Verdict } from '../../src/features';
import { clearReports, listReports } from '../../src/feedback';
import type { SenderInfo } from '../../src/sender';
import { type IntelState, renderITDetailsContent, renderSimpleDetails } from '../../src/ui/details';

const kv = browser.storage.local;
const $ = (id: string) => document.getElementById(id)!;

interface TabState { verdict: Verdict; sender?: SenderInfo; intel?: IntelState }

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
  out.className = '';

  const badge = document.createElement('div');
  if (st.verdict.level === 'likely-phishing') {
    badge.className = 'status status-danger';
    badge.textContent = 'Possible phishing email';
  } else if (st.verdict.level === 'suspicious') {
    badge.className = 'status status-danger';
    badge.textContent = 'This email looks suspicious';
  } else if (senderWarnings.length > 0) {
    badge.className = 'status status-warn';
    badge.textContent = 'Double-check this sender';
  } else {
    badge.className = 'status status-safe';
    badge.textContent = 'Looks safe';
  }
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
    itDetails.className = '';
    itDetails.append(renderITDetailsContent(document, st.sender, st.intel, st.verdict, allReasons));
  }
}

async function renderTrusted() {
  const ul = $('trusted');
  ul.textContent = '';
  const list = await listTrusted(kv);
  if (!list.length) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = 'None'; ul.append(li); }
  for (const s of list) {
    const li = document.createElement('li');
    li.textContent = s;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Remove';
    b.addEventListener('click', async () => { await untrustSender(kv, s); await renderTrusted(); });
    li.append(b);
    ul.append(li);
  }
}

async function renderReports() {
  $('reports').textContent = String((await listReports(kv)).length);
}

$('clear').addEventListener('click', async () => { await clearReports(kv); await renderReports(); });
void Promise.all([renderVerdict(), renderTrusted(), renderReports()]);
