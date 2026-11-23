import { listTrusted, untrustSender } from '../../src/allowlist';
import { intelWarnings } from '../../src/domainIntel';
import type { Verdict } from '../../src/features';
import { clearReports, listReports } from '../../src/feedback';
import type { SenderInfo } from '../../src/sender';
import { type IntelState, renderDetails } from '../../src/ui/details';

const kv = browser.storage.local;
const $ = (id: string) => document.getElementById(id)!;

interface TabState { verdict: Verdict; sender?: SenderInfo; intel?: IntelState }

async function renderVerdict() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  const key = `tab:${tab.id}`;
  const st = (await browser.storage.session?.get?.(key))?.[key] as TabState | undefined;
  if (!st?.verdict) return;
  const out = $('out');
  out.textContent = '';
  out.className = '';
  const h = document.createElement('strong');
  h.textContent = `${st.verdict.level} (${st.verdict.score.toFixed(2)})`;
  const reasons = [...st.verdict.reasons, ...(st.sender?.warnings ?? []), ...(typeof st.intel === 'object' ? intelWarnings(st.intel) : [])];
  const ul = document.createElement('ul');
  for (const r of reasons) { const li = document.createElement('li'); li.textContent = r; ul.append(li); }
  out.append(h, ul);
  if (st.sender) out.append(renderDetails(document, st.sender, st.intel));
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
