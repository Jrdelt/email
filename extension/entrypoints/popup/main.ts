import { clearTrustedEmails, listTrusted, listTrustedEmails, untrustSender } from '../../src/allowlist';
import { intelWarnings } from '../../src/domainIntel';
import type { Verdict } from '../../src/features';
import { clearReports, listReports } from '../../src/feedback';
import type { SenderInfo } from '../../src/sender';
import { type IntelState, renderITDetailsContent, renderSimpleDetails } from '../../src/ui/details';
import { createLogoSvg, createStatusIcon } from '../../src/ui/icons';

const kv = browser.storage.local;
const $ = (id: string) => document.getElementById(id)!;

interface TabState { verdict: Verdict; sender?: SenderInfo; intel?: IntelState }

$('logo').append(createLogoSvg(document, 32));

async function renderVerdict() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  const key = `tab:${tab.id}`;
  const st = (await browser.storage.session?.get?.(key))?.[key] as TabState | undefined;
  if (!st?.verdict) return;

  const intelList = typeof st.intel === 'object' ? intelWarnings(st.intel) : [];
  const senderWarnings = [...(st.sender?.warnings ?? []), ...intelList];
  const danger = st.verdict.level !== 'safe';
  const allReasons = danger
    ? [...st.verdict.reasons, ...senderWarnings]
    : [...senderWarnings, ...st.verdict.reasons];

  const out = $('out');
  out.textContent = '';
  out.className = 'card';

  let kind: 'safe' | 'warning' | 'danger' = 'safe';
  let label = 'Looks safe.';
  let tagText = 'SAFE';
  if (st.verdict.level === 'likely-phishing') {
    kind = 'danger';
    label = 'Possible phishing.';
    tagText = 'PHISHING WARNING';
  } else if (st.verdict.level === 'suspicious') {
    kind = 'danger';
    label = 'Looks suspicious.';
    tagText = 'PHISHING WARNING';
  } else if (senderWarnings.length > 0) {
    kind = 'warning';
    label = 'Check this sender.';
    tagText = intelList.length > 0 ? 'DOMAIN WARNING' : 'SENDER CHECK';
  }

  const row = document.createElement('div');
  row.className = 'status-row';

  const iconBox = document.createElement('div');
  iconBox.className = kind === 'safe' ? 'icon-box icon-safe' : 'icon-box icon-alert';
  iconBox.append(createStatusIcon(document, kind, 20));

  const titleWrap = document.createElement('div');
  const titleEl = document.createElement('div');
  titleEl.className = 'status-title';
  titleEl.textContent = label;
  const tagEl = document.createElement('span');
  tagEl.className = 'tag';
  tagEl.textContent = tagText;
  titleWrap.append(titleEl, tagEl);

  row.append(iconBox, titleWrap);
  out.append(row);

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

async function renderTrustedEmails() {
  const count = (await listTrustedEmails(kv)).length;
  $('trusted-emails-row').hidden = count === 0;
  $('trusted-emails-label').textContent = count === 1 ? '1 trusted email saved' : `${count} trusted emails saved`;
}

async function renderReports() {
  $('reports').textContent = String((await listReports(kv)).length);
}

$('clear-emails').addEventListener('click', async () => { await clearTrustedEmails(kv); await renderTrustedEmails(); });
$('clear').addEventListener('click', async () => { await clearReports(kv); await renderReports(); });
void Promise.all([renderVerdict(), renderTrusted(), renderTrustedEmails(), renderReports()]);
