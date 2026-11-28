// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// The banner's "I trust this email" and Undo apply at once for this session; remembering the fingerprint (or
// forgetting it) is a storage write that can fail, e.g. in a content script orphaned by an extension update. A failed
// write must never leave the links open behind a warning card, nor keep them open after Undo.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Msg, bootContent, captureBanner, fakeBrowser, quietly, settled, tick, until } from './harness';

const ADDRESS = 'jordan@northwind.example';
const PAGE = `<h2 class="hP">Meeting minutes</h2>
  <div class="adn"><span class="gD" email="${ADDRESS}" name="Jordan Lee">Jordan Lee</span>
    <span data-tooltip="Gmail couldn't verify that northwind.example sent this message">?</span>
    <div class="a3s">Hi team, the <a id="agenda" href="https://northwind.example/agenda">agenda</a> is on the
      wiki. Thanks!</div></div>`;

const banner = captureBanner();
let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  await quietly(settled(sent));
});

let failing: { mockRestore: () => void } | undefined;
afterEach(() => failing?.mockRestore()); // not vi.restoreAllMocks(): that would also undo captureBanner()

const failWrites = () => {
  failing = vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('Extension context invalidated.'));
};
const linksLocked = () => document.querySelector('div.a3s')!.hasAttribute('data-ped-locked');
const PILL = 'Email trusted — links enabled';

describe('content.ts: banner actions when storage writes fail', () => {
  it('shows the sender warning with the links paused', () => {
    expect(banner.text()).toContain('Check this sender.');
    expect(linksLocked()).toBe(true);
  });

  it('Undo re-locks the links even when forgetting the fingerprint fails', async () => {
    banner.button('I trust this email').click();
    await until(() => expect(banner.text()).toContain(PILL));
    expect(linksLocked()).toBe(false);

    failWrites();
    banner.button('Undo').click();
    for (let i = 0; i < 5 && !linksLocked(); i++) await tick();
    expect(linksLocked(), 'links locked after Undo').toBe(true);
    expect(banner.text()).toContain('Check this sender.');
    expect(banner.button('I trust this email').disabled).toBe(false);
  });

  it('"I trust this email" shows the trusted pill even when remembering the fingerprint fails', async () => {
    failWrites();
    banner.button('I trust this email').click();
    await until(() => expect(banner.text()).toContain(PILL));
    expect(linksLocked()).toBe(false);
    expect(banner.text()).not.toContain('Links are paused');
  });
});
