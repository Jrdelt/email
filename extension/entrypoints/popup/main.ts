import { clearTrustedEmails, listTrusted, listTrustedEmails, untrustSender } from '../../src/allowlist';
import type { AttachmentAnalysis } from '../../src/attachments';
import type { Verdict } from '../../src/features';
import { clearReports, listReports } from '../../src/feedback';
import type { SenderInfo } from '../../src/sender';
import { clearAllLocalData, getSettings, setStrictLocalMode } from '../../src/settings';
import { deriveStatusSummary } from '../../src/ui/banner';
import { type IntelState, renderITDetailsContent, renderSimpleDetails } from '../../src/ui/details';
import { createLogoSvg, createStatusIcon } from '../../src/ui/icons';

const kv = browser.storage.local;
const $ = (id: string) => document.getElementById(id)!;

interface TabState {
  verdict: Verdict;
  sender?: SenderInfo;
  intel?: IntelState;
  attachments?: AttachmentAnalysis;
  trusted?: boolean;
}

$('logo').append(createLogoSvg(document, 32));

async function renderVerdict() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  const key = `tab:${tab.id}`;
  const st = (await browser.storage.session?.get?.(key))?.[key] as TabState | undefined;
  if (!st?.verdict) return;

  const summary = deriveStatusSummary(st.verdict, st.sender, st.intel, st.attachments, Boolean(st.trusted));

  const out = $('out');
  out.textContent = '';
  out.className = 'card';

  const row = document.createElement('div');
  row.className = 'status-row';

  const iconBox = document.createElement('div');
  iconBox.className =
    summary.kind === 'safe'
      ? 'icon-box icon-safe'
      : summary.kind === 'warning'
        ? 'icon-box icon-warn'
        : 'icon-box icon-alert';
  iconBox.setAttribute('aria-hidden', 'true');
  iconBox.append(createStatusIcon(document, summary.kind, 20));

  const titleWrap = document.createElement('div');
  const titleEl = document.createElement('div');
  titleEl.className = 'status-title';
  titleEl.textContent = summary.title;
  const tagEl = document.createElement('span');
  tagEl.className = 'tag';
  tagEl.textContent = summary.tag;
  titleWrap.append(titleEl, tagEl);

  row.append(iconBox, titleWrap);
  out.append(row);

  if (summary.kind !== 'safe' && summary.reasons.length > 0) {
    const ul = document.createElement('ul');
    for (const r of summary.reasons.slice(0, 3)) {
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
    itDetails.append(renderITDetailsContent(document, st.sender, st.intel, st.verdict, summary.reasons));
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
    b.setAttribute('aria-label', `Remove ${s} from trusted senders`);
    b.addEventListener('click', async () => {
      await untrustSender(kv, s);
      await renderTrusted();
    });
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

async function renderPrivacySettings() {
  const s = await getSettings(kv, browser.storage.managed);
  const checkbox = $('strict-local') as HTMLInputElement;
  checkbox.checked = s.strictLocalMode;
  checkbox.disabled = s.managedLocked;
  $('privacy-note').textContent = s.managedLocked
    ? s.strictLocalMode
      ? 'Enforced by IT policy: 0 network lookups (HIPAA/enterprise local-only mode).'
      : 'Managed by IT policy. Email content and full URLs never leave your browser.'
    : s.strictLocalMode
      ? 'Strict Local Mode active: 0 network lookups leave your browser.'
      : 'Email bodies, attachments, addresses, and full URLs stay local; only bare website domains are checked online.';
}

($('strict-local') as HTMLInputElement).addEventListener('change', async (e) => {
  await setStrictLocalMode(kv, (e.currentTarget as HTMLInputElement).checked, browser.storage.managed);
  await renderPrivacySettings();
});
$('clear-all-data').addEventListener('click', async () => {
  await clearAllLocalData(kv);
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) await browser.storage.session?.remove?.(`tab:${tab.id}`).catch(() => {});
  $('clear-all-status').textContent = 'All local data cleared.';
  await Promise.all([renderTrusted(), renderTrustedEmails(), renderReports()]);
});
$('clear-emails').addEventListener('click', async () => { await clearTrustedEmails(kv); await renderTrustedEmails(); });
$('clear').addEventListener('click', async () => { await clearReports(kv); await renderReports(); });
$('help-clicked').addEventListener('click', () => {
  void browser.tabs.create({ url: browser.runtime.getURL('/warning.html?mode=help'), active: true });
});
void Promise.all([renderPrivacySettings(), renderVerdict(), renderTrusted(), renderTrustedEmails(), renderReports()]);
