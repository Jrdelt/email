// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://p55-mail.icloud-sandbox.com/applications/mail2-message/current/en-us/index.html"}
// C20: an iCloud sandbox message frame whose body carries an inline download (<a download href="data:...">). The
// app frame decides "links open, attachments locked" for this body (icloudLock {locked: false, attachmentsLocked:
// true}, as for an untrusted email that scores safe): the frame then locks the download itself (entrypoints/content.ts
// runICloudSandbox syncInlineAttachmentLocks), cancels its activation, and asks the app frame to show its banner. A
// later decision that also opens attachments (the user trusted the email) gives the download back.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, deliver, press, quietly, tick, until } from './harness';

const DATA_PDF = 'data:application/pdf;base64,JVBERi0xLjQK';
const PAGE = `<p>Hi, the minutes from Tuesday are attached. The
  <a id="agenda" href="https://corp.example/agenda">agenda</a> is on the wiki.</p>
  <a id="dl" download="minutes.pdf" href="${DATA_PDF}">minutes.pdf</a>`;

let sent: Msg[];
let sig: unknown;

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  await quietly(until(() => expect(sent.some((m) => m.type === 'icloudBody' && m.active === true)).toBe(true)));
  sig = sent.find((m) => m.type === 'icloudBody' && m.active === true)?.sig;
});

const decide = (attachmentsLocked: boolean) =>
  deliver({ type: 'icloudLock', locked: false, attachmentsLocked, sig });

describe('content.ts: iCloud sandbox frame with an inline download', () => {
  it('reports the download with its body', () => {
    expect(sent.find((m) => m.type === 'icloudBody' && m.active === true)).toMatchObject({
      attachmentNames: ['minutes.pdf'],
      sig: expect.stringMatching(/^[0-9a-f]+$/),
    });
  });

  it('locks the download, not the links, when the decision locks attachments only', async () => {
    await decide(true);
    expect(document.body.hasAttribute('data-ped-locked'), 'links locked').toBe(false);
    expect($('agenda').getAttribute('href')).toBe('https://corp.example/agenda');
    const dl = $('dl');
    expect(dl.hasAttribute('data-ped-att-locked'), 'download locked').toBe(true);
    expect(dl.hasAttribute('href'), 'live href').toBe(false);
    expect(dl.hasAttribute('download'), 'live download').toBe(false);
  });

  it('cancels a click and Enter on the download and asks the app frame for its banner', async () => {
    const mark = sent.length;
    expect(click($('dl')), 'click cancelled').toBe(true);
    expect(press($('dl'), 'Enter'), 'Enter cancelled').toBe(true);
    expect(document.getElementById('ped-toast-host'), '"attachment blocked" notice').not.toBeNull();
    await tick();
    expect(sent.slice(mark)).toContainEqual({ type: 'icloudBlocked' });
  });

  it('gives the download back when a later decision opens attachments too', async () => {
    await decide(false);
    const dl = $('dl');
    expect(dl.hasAttribute('data-ped-att-locked')).toBe(false);
    expect(dl.getAttribute('href')).toBe(DATA_PDF);
    expect(dl.getAttribute('download')).toBe('minutes.pdf');
  });
});
