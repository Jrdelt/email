// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// The Gmail adapter reads Gmail's sender-verification labels ("couldn't verify", "via") in English only. With Gmail in
// another UI language (<html lang="de">) a forged copy of a trusted address shows Gmail's localized badge, which the
// adapter cannot read, so the forgery would look verified. There the adapter reports no auth signals, and sender
// trust gets the treatment of the webmails whose verification is invisible (content.trusted-outlook-attachment.test.ts):
// no warning banner and links open, but the attachment stays locked behind the attachment notice.
// The English counterpart, where sender trust opens the attachment too, is content.trusted-gmail-download.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, fakeBrowser, lastVerdict, navigations, press, quietly, tick, until } from './harness';

const ADDRESS = 'alex@corp.example';
const DATA_PDF = 'data:application/pdf;base64,JVBERi0xLjQK';
// Gmail's German "couldn't verify" badge, outside the message body.
const TIP = 'Gmail konnte nicht bestätigen, dass corp.example diese Nachricht gesendet hat';
const PAGE = `<h2 class="hP">Rechnung</h2>
  <div class="adn"><span class="gD" email="${ADDRESS}" name="Alex Kim">Alex Kim</span>
    <span data-tooltip="${TIP}" aria-label="${TIP}">?</span>
    <div class="a3s">Hallo, die Rechnung ist angehängt.
      <a id="dl" download="Rechnung_0412.pdf" href="${DATA_PDF}">Rechnung_0412.pdf</a></div></div>`;

let sent: Msg[];

beforeAll(async () => {
  document.documentElement.setAttribute('lang', 'de'); // Gmail sets <html lang> to its UI language
  ({ sent } = await bootContent(PAGE, {
    beforeMain: () => fakeBrowser.storage.local.set({ trustedSenders: [ADDRESS] }),
  }));
  // Any verdict for this sender: the tests below check what it decided, so a wrong decision names itself.
  await quietly(until(() => expect(lastVerdict(sent)).toMatchObject({ sender: { address: ADDRESS } })));
  await tick();
});

describe('content.ts: trusted sender on a non-English Gmail', () => {
  it('does not trust the email as a whole: its attachment needs "I trust this email"', () => {
    const v = lastVerdict(sent)!;
    expect(v).toMatchObject({
      verdict: { level: 'safe' },
      sender: { address: ADDRESS, allowlisted: true, warnings: [] },
      attachments: { count: 1, level: 'locked', names: ['Rechnung_0412.pdf'] },
      trusted: false,
    });
    expect((v.attachments as unknown as { reasons: string[] }).reasons.at(-1)).toMatch(
      /can't show the extension that the email really came from them/,
    );
  });

  it('keeps the inline download locked: href stashed, click and Enter cancelled', () => {
    const dl = $('dl');
    expect(dl.hasAttribute('data-ped-att-locked'), 'download locked').toBe(true);
    expect(dl.hasAttribute('href')).toBe(false);
    expect(click(dl)).toBe(true);
    expect(press(dl, 'Enter')).toBe(true);
    expect(navigations(sent)).toEqual([]);
  });
});
