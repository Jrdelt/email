// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.proton.me/u/0/inbox"}
// Proton renders each message body in a same-origin srcdoc iframe. When the webmail swaps that iframe's document in
// place (srcdoc set again), nothing changes in the top document and the old document is gone, so neither mutation
// observer fires; the iframe's load event waits for every subresource, and an image that is never answered delays it
// forever. The new body must still be scanned, guarded and locked: the old document's pagehide (which browsers fire
// on such a swap; checked in Chromium) brings a rescan.
// happy-dom swaps the document synchronously and fires neither pagehide nor a delayed load, so the test dispatches
// pagehide as the browser does (on the old window, before the new document is in) and holds back the iframe's load
// event, as a never-answered image would.
import { beforeAll, describe, expect, it } from 'vitest';
import { type Msg, bootContent, click, lastVerdict, navigations, settled, until } from './harness';

const BENIGN = '<p>Your order 1042 has shipped. Thanks for shopping with us!</p>';
const PHISHING = `<p>Urgent: your password expired. Verify immediately or your account will be suspended.
  <a id="lnk" href="https://evil.example/login">https://www.paypal.com/signin</a></p>
  <img src="https://evil-cdn.example/hang.png">`;
const PAGE = `<div data-testid="conversation-view">
  <h1 data-testid="conversation-header:subject">Your order</h1>
  <article data-testid="message-view-0">
    <div data-testid="message-header:from" title="orders@shop.example">Shop</div>
    <iframe data-testid="content-iframe" id="frame" srcdoc="${BENIGN}"></iframe>
  </article></div>`;

let sent: Msg[];
let holdFrameLoads = false;
const frame = () => document.getElementById('frame') as HTMLIFrameElement;

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: async () => {
      // Registered before the content script's own capture listener on document (load events do not reach window),
      // so a held-back load never reaches it.
      document.addEventListener(
        'load',
        (e) => {
          if (holdFrameLoads && e.target instanceof HTMLIFrameElement) e.stopImmediatePropagation();
        },
        true,
      );
      await until(() => expect(frame().contentDocument?.body?.textContent).toContain('shipped'));
    },
  }));
  await settled(sent);
});

describe('content.ts: a message iframe whose document is swapped in place', () => {
  it('starts with the benign body scanned', () => {
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, sender: { address: 'orders@shop.example' } });
  });

  it('scans, locks and guards the new body although its load event never comes', async () => {
    holdFrameLoads = true;
    const mark = sent.length;
    // The browser's order: the old document's pagehide fires before the new document replaces it.
    frame().contentWindow!.dispatchEvent(new Event('pagehide'));
    frame().srcdoc = PHISHING;
    await until(() =>
      expect(lastVerdict(sent.slice(mark))).toMatchObject({ verdict: { level: 'likely-phishing' } }),
    );
    const doc = frame().contentDocument!;
    expect(doc.body.hasAttribute('data-ped-locked'), 'new body locked').toBe(true);
    expect(click(doc.getElementById('lnk')!), 'click cancelled').toBe(true);
    expect(navigations(sent, mark)).toEqual([]);
  });
});
