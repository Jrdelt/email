// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://p55-mail.icloud-sandbox.com/applications/mail2-message/current/en-us/index.html"}
// A "#fragment" link normally stays on its page, so the click guard lets it through. But it resolves against the
// document's base URL: in an iCloud message frame the email is the whole document, and a <base href> in it sends
// <a href="#open"> to another site. Such a click must get the same click-time check as a plain link to that URL.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, deliver, navigations, tick, until } from './harness';

const PAGE = `<base href="https://files.example/invoice.exe">
  <p>Hi, your invoice for October is ready. Thanks for your business!</p>
  <a id="open" href="#open">Open invoice</a>
  <p id="top">Contents: <a id="toc" href="#top">back to top</a></p>`;

let sent: Msg[];

/** Browsers resolve an anchor's href against the document base URL (<base href>); happy-dom ignores the base. */
function resolveHrefAgainstBase(): void {
  Object.defineProperty(HTMLAnchorElement.prototype, 'href', {
    configurable: true,
    get(this: HTMLAnchorElement) {
      const raw = Element.prototype.getAttribute.call(this, 'href');
      return raw === null ? '' : new URL(raw, this.ownerDocument.baseURI).href;
    },
    set(this: HTMLAnchorElement, value: string) {
      Element.prototype.setAttribute.call(this, 'href', value);
    },
  });
}

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, { beforeMain: resolveHrefAgainstBase }));
  const report = await until(() => {
    const r = sent.find((m) => m.type === 'icloudBody' && m.active === true);
    expect(r).toBeDefined();
    return r!;
  });
  // The app frame found nothing wrong: the frame is unlocked and nothing is pending.
  await deliver({ type: 'icloudLock', locked: false, attachmentsLocked: false, sig: report.sig });
  await tick();
});

describe('content.ts: "#fragment" links under a <base href>', () => {
  it('checks a fragment link that the base sends to another site (risky download: warning page)', async () => {
    const mark = sent.length;
    expect(click($('open')), 'click cancelled').toBe(true);
    await until(() =>
      expect(navigations(sent, mark)).toEqual([
        expect.objectContaining({ type: 'openWarning', href: 'https://files.example/invoice.exe#open' }),
      ]),
    );
  });

  it('still lets a fragment link through natively when no <base> sends it elsewhere', async () => {
    document.querySelector('base')!.remove();
    await tick();
    const mark = sent.length;
    expect(click($('toc'))).toBe(false);
    await tick();
    expect(navigations(sent, mark)).toEqual([]);
  });
});
