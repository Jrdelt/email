import type { Verdict } from '../../src/features';

async function render() {
  const out = document.getElementById('out')!;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  const key = `tab:${tab.id}`;
  const v = (await browser.storage.session?.get?.(key))?.[key] as Verdict | undefined;
  if (!v) return;
  out.textContent = '';
  const h = document.createElement('strong');
  h.textContent = `${v.level} (${v.score.toFixed(2)})`;
  const ul = document.createElement('ul');
  for (const r of v.reasons) { const li = document.createElement('li'); li.textContent = r; ul.append(li); }
  out.append(h, ul);
}
render();
