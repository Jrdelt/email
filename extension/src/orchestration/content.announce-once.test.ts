// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// Screen readers read every inserted role=alert card in full, so a warning is announced once per email: a re-render
// of the same email's warning (the sender lookup's result, the rescan that Undo's own storage write starts) is a
// role=region landmark. Another email shown in its place with the same title is announced again.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type Msg, bootContent, gmailMessage, quietly, settled, tick, until } from './harness';

const email = (from: string) =>
  gmailMessage({
    name: 'PayPal Billing',
    email: from,
    subject: 'Invoice',
    body: 'Hello, your invoice is ready. See <a href="https://example.org/inv">invoice</a>. Thanks.',
  });
const A = email('team@paypa1-billing.example');
const B = email('team@paypa1-invoices.example');

// The banner's shadow root is closed: keep a handle on it to read the card.
const shadowRoots = new WeakMap<Element, ShadowRoot>();
const attach = HTMLElement.prototype.attachShadow;
vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, init) {
  const root = attach.call(this, init);
  shadowRoots.set(this, root);
  return root;
});
const root = () => {
  const host = document.getElementById('ped-banner-host');
  return host ? (shadowRoots.get(host) ?? null) : null;
};
const button = (label: string) => [...(root()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label)!;
const cardText = () => root()?.querySelector('.card')?.textContent ?? '';

// Role and title of every banner card inserted, in order.
const inserted: string[] = [];
let sent: Msg[];

beforeAll(async () => {
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement) || n.id !== 'ped-banner-host') continue;
        const sr = shadowRoots.get(n);
        inserted.push(`${sr?.querySelector('.card')?.getAttribute('role')}:${sr?.querySelector('#ped-title')?.textContent}`);
      }
    }
  }).observe(document.documentElement, { childList: true });
  ({ sent } = await bootContent(A));
  await quietly(settled(sent));
  await tick();
});

describe('content.ts: a warning is announced once per email', () => {
  it('announces the first card and not its re-render', () => {
    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted[0]).toMatch(/^alert:/);
    expect(inserted.slice(1).every((c) => c.startsWith('region:'))).toBe(true);
  });

  it('announces the warning once after Undo, not again for the rescan its storage write starts', async () => {
    button('I trust this email').click();
    await until(() => expect(cardText()).toContain('Email trusted'));
    const mark = inserted.length;
    const sentMark = sent.length;
    button('Undo').click();
    // The rescan after Undo's storage write looks the sender up again; wait for it to render.
    await until(() => expect(sent.slice(sentMark).some((m) => m.type === 'domainIntel')).toBe(true));
    await quietly(settled(sent, sentMark));
    await tick();
    const after = inserted.slice(mark);
    expect(after.length).toBeGreaterThan(1);
    expect(after.filter((c) => c.startsWith('alert:'))).toHaveLength(1);
    expect(after[0]).toMatch(/^alert:/);
  });

  it('announces another email shown in its place, even with the same title', async () => {
    const mark = inserted.length;
    const sentMark = sent.length;
    const title = inserted.at(-1)!.split(':').slice(1).join(':');
    document.body.innerHTML = B; // Gmail's Older/Newer arrows replace the message in place
    await quietly(settled(sent, sentMark));
    await tick();
    const after = inserted.slice(mark);
    expect(after[0]).toBe(`alert:${title}`);
  });
});
