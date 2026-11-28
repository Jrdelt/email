// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// Trust given in another tab (the same email or sender open twice) reaches this tab through storage.onChanged: the
// email is rescanned and opened here too, as a revocation elsewhere locks it again. This tab's own "I trust this
// email" is not rescanned for (it already applied the trust), so its Undo pill stays.
import { beforeAll, describe, expect, it } from 'vitest';
import { gmail } from '../adapters/gmail';
import { hashEmail } from '../allowlist';
import { $, type Msg, bootContent, captureBanner, fakeBrowser, lastVerdict, quietly, settled, until } from './harness';

const ADDRESS = 'billing@northwind.example';
const PAGE = `<h2 class="hP">Account notice</h2>
  <div class="adn"><span class="gD" email="${ADDRESS}" name="Northwind Billing">Northwind Billing</span>
    <div class="a3s">Your account is locked. Verify your password now or it will be suspended.
      <a id="link" href="https://login.northwind-verify.example/">Verify now</a></div></div>`;

const banner = captureBanner();
let sent: Msg[];
let fingerprint: string;

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: async () => {
      const [email] = gmail.extractAll!(document);
      fingerprint = await hashEmail(email!.senderAddress, email!.body, email!.links, [], { attachmentCount: 0 });
    },
  }));
  await quietly(settled(sent));
});

const locked = () => document.querySelector('div.a3s')!.hasAttribute('data-ped-locked');
/** Another tab (or the popup) writes storage. */
const elsewhere = (items: Record<string, unknown>) => fakeBrowser.storage.local.set(items);

describe('content.ts: trust added in another tab', () => {
  it('starts locked behind a warning', () => {
    expect(lastVerdict(sent)).toMatchObject({ trusted: false, sender: { address: ADDRESS } });
    expect(locked()).toBe(true);
    expect(banner.root()).not.toBeNull();
  });

  it('"Always trust sender" in another tab opens the email here', async () => {
    await elsewhere({ trustedSenders: [ADDRESS] });
    await until(() => expect(lastVerdict(sent)).toMatchObject({ trusted: true, sender: { address: ADDRESS } }));
    expect(locked()).toBe(false);
    expect($('link').getAttribute('href')).toBe('https://login.northwind-verify.example/');
    expect(banner.root()).toBeNull();
  });

  it('removing it there locks the email here again', async () => {
    const mark = sent.length;
    await elsewhere({ trustedSenders: [] });
    await until(() => expect(lastVerdict(sent.slice(mark))).toMatchObject({ trusted: false }));
    expect(locked()).toBe(true);
  });

  it('"I trust this email" in another tab opens the email here', async () => {
    await elsewhere({ trustedEmails: [fingerprint] });
    await until(() => expect(lastVerdict(sent)).toMatchObject({ trusted: true }));
    expect(locked()).toBe(false);
    await elsewhere({ trustedEmails: [] });
    await until(() => expect(locked()).toBe(true));
  });

  it("this tab's own \"I trust this email\" keeps its Undo pill (no rescan for its own write)", async () => {
    await until(() => expect(banner.root()).not.toBeNull());
    banner.button('I trust this email').click(); // a phishing alert asks to confirm
    banner.button('Yes, unlock links anyway').click();
    await until(() => expect(banner.text()).toContain('Email trusted'));
    await until(async () => expect((await fakeBrowser.storage.local.get('trustedEmails')).trustedEmails).toEqual([fingerprint]));
    const mark = sent.length;
    await new Promise((r) => setTimeout(r, 700)); // longer than the rescan debounce
    expect(banner.text()).toContain('Email trusted');
    expect(banner.button('Undo').disabled).toBe(false);
    expect(sent.slice(mark).filter((m) => m.type === 'verdict'), 'no rescan').toEqual([]);
  });
});
