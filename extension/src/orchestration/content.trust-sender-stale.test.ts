// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// "Always trust sender" stores the address and then re-renders. If a newer scan has rendered in the meantime (a
// phishing reply from someone else landed while the write was pending), the old scan's render must not run: it would
// remove the reply's banner, report the tab as trusted and leave the reply locked with no way to bring the banner
// back. The stored trust reaches the current scan through the rescan the storage change brings.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { $, type Msg, bootContent, captureBanner, click, fakeBrowser, lastVerdict, quietly, settled, until } from './harness';

const ADDRESS = 'billing@northwind.example';
const PHISHER = 'help@paypa1-secure.example';
const message = (o: { id: string; name: string; email: string; body: string }) =>
  `<span class="gD" email="${o.email}" name="${o.name}">${o.name}</span><div class="a3s" id="${o.id}">${o.body}</div>`;

const PAGE = `<h2 class="hP">Account notice</h2>
  <div class="adn">${message({
    id: 'first',
    name: 'Northwind Billing',
    email: ADDRESS,
    body: `Your account is locked. Verify your password now or it will be suspended.
      <a id="l1" href="https://login.northwind-verify.example/">Verify now</a>`,
  })}</div>`;

const banner = captureBanner();
let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  await quietly(settled(sent));
});

const locked = (id: string) => $(id).hasAttribute('data-ped-locked');

describe('content.ts: "Always trust sender" resolving after a newer scan rendered', () => {
  it('leaves the newer scan in charge and applies the trust through a rescan', async () => {
    expect(banner.button('Always trust sender').disabled).toBe(false);
    const write = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementation(async (items) => {
      if ('trustedSenders' in items) await gate;
      return write(items);
    });

    banner.button('Always trust sender').click();
    banner.button('Yes, always trust this sender').click(); // a danger banner asks first
    // While the write is pending, a phishing reply from someone else arrives and is scanned.
    const reply = document.createElement('div');
    reply.className = 'adn';
    reply.innerHTML = message({
      id: 'reply',
      name: 'PayPal Support',
      email: PHISHER,
      body: `Your PayPal account is locked. Verify your password now or it will be suspended.
        <a id="l2" href="https://evil.example/login">www.paypal.com</a>`,
    });
    document.querySelector('div.adn')!.after(reply);
    const mark = sent.length;
    await settled(sent, mark);
    expect(lastVerdict(sent)).toMatchObject({ trusted: false, sender: { address: PHISHER } });
    expect(banner.root(), "the reply's banner").not.toBeNull();

    const afterWrite = sent.length;
    release();
    // The rescan for the stored trust: the first message is now trusted, the reply still flagged.
    await until(() => expect(locked('first'), 'first message opened by the rescan').toBe(false));
    spy.mockRestore();
    expect(lastVerdict(sent), 'tab verdict').toMatchObject({ trusted: false, sender: { address: PHISHER } });
    expect(
      sent.slice(afterWrite).filter((m) => m.type === 'verdict').some((m) => (m.payload as { trusted?: boolean })?.trusted),
      'the tab was never reported trusted',
    ).toBe(false);
    expect(locked('reply')).toBe(true);
    expect(banner.root(), "the reply's banner is still shown").not.toBeNull();
    expect(banner.text()).toContain('PHISHING ALERT');
    expect(click($('l2'))).toBe(true);
  });
});
