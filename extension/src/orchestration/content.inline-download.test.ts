// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C2: an untrusted email whose body scores safe but carries an inline download (<a download href="data:...">).
// Its ordinary links stay usable, yet the download is always blocked (AGENTS.md: attachments from untrusted
// email are locked even when the body scores safe). A click on the download before the first scan is held too.
//
// The filename is deliberately benign (minutes.pdf). A dangerous name such as invoice.pdf.html is classified as a
// dangerous attachment, which by design pauses the links as well: content.dangerous-download.test.ts covers that.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, gmailMessage, lastVerdict, press, settled, verdictsOf } from './harness';

const PAGE = gmailMessage({
  name: 'Jordan Lee',
  email: 'jordan@northwind.example',
  subject: 'Meeting minutes',
  body: `Hi team, the minutes from Tuesday's meeting are attached. The
    <a id="agenda" href="https://northwind.example/agenda">agenda</a> is on the wiki. Thanks!
    <a id="dl" download="minutes.pdf" href="data:application/pdf;base64,JVBERi0xLjQK">minutes.pdf</a>`,
});

let sent: Msg[];
let verdictsBeforeEarlyClick: number;
let earlyDownloadCancelled: boolean;

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  verdictsBeforeEarlyClick = verdictsOf(sent).length;
  earlyDownloadCancelled = click($('dl')); // before the first scan: the attachment is not locked yet
  await settled(sent);
});

describe('content.ts: safe-scoring email with an inline download in Gmail', () => {
  it('holds a click on the download made before the first scan', () => {
    expect(verdictsBeforeEarlyClick).toBe(0);
    expect(earlyDownloadCancelled).toBe(true);
  });

  it('reports a safe body with one locked attachment', () => {
    expect(lastVerdict(sent)).toMatchObject({
      verdict: { level: 'safe' },
      attachments: { count: 1, level: 'locked', names: ['minutes.pdf'] },
      trusted: false,
    });
  });

  it('does not pause the links: no body lock, href kept, a same-site link click goes through', () => {
    expect(document.querySelector('div.a3s')!.hasAttribute('data-ped-locked')).toBe(false);
    expect($('agenda').getAttribute('href')).toBe('https://northwind.example/agenda');
    expect(click($('agenda'))).toBe(false);
  });

  it('blocks the inline download: marked locked, href and download stashed, click and Enter cancelled', () => {
    const dl = $('dl');
    expect(dl.hasAttribute('data-ped-att-locked')).toBe(true);
    expect(dl.hasAttribute('href')).toBe(false);
    expect(dl.hasAttribute('download')).toBe(false);
    expect(click(dl)).toBe(true);
    expect(press(dl, 'Enter')).toBe(true);
    expect(sent.some((m) => m.type === 'openSafeLink' || m.type === 'openWarning')).toBe(false);
  });
});
