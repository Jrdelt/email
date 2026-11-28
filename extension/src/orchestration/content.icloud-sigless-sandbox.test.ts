// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://p55-mail.icloud-sandbox.com/applications/mail2-message/current/en-us/index.html"}
// A decision the app frame made before it saw this frame's body carries no signature. Once the frame has reported
// a body it may only tighten: it neither releases the race-to-click hold nor unlocks links or inline downloads.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, deliver, navigations, tick, until } from './harness';

const DATA_HTML = 'data:text/html;base64,PGgxPkxvZ2luPC9oMT4=';
const PAGE = `<p>Your Apple ID is locked. Verify your password now or it will be suspended.</p>
  <a id="link" href="https://evil.example/login">www.apple.com</a>
  <a id="dl" download="invoice.pdf.html" href="${DATA_HTML}">invoice.pdf.html</a>`;

let sent: Msg[];
let report: Msg;
const locked = () => document.body.hasAttribute('data-ped-locked');

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  report = await until(() => {
    const r = sent.find((m) => m.type === 'icloudBody' && m.active === true);
    expect(r).toBeDefined();
    return r!;
  });
  await tick();
});

describe('content.ts: iCloud sandbox frame, decisions without a signature', () => {
  it('a sig-less unlock neither releases a held click nor opens links or downloads', async () => {
    const mark = sent.length;
    expect(click($('link'))).toBe(true);
    await deliver({ type: 'icloudLock', locked: false, attachmentsLocked: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(navigations(sent, mark)).toEqual([]);
    expect(click($('dl')), 'download click still held').toBe(true);
  });

  it('a sig-less lock still applies', async () => {
    await deliver({ type: 'icloudLock', locked: true, attachmentsLocked: true });
    expect(locked()).toBe(true);
    expect($('dl').hasAttribute('data-ped-att-locked')).toBe(true);
  });

  it('only a decision for this body unlocks it', async () => {
    await deliver({ type: 'icloudLock', locked: false, attachmentsLocked: false });
    expect(locked()).toBe(true);
    await deliver({ type: 'icloudLock', locked: false, attachmentsLocked: false, sig: report.sig });
    expect(locked()).toBe(false);
    expect($('dl').hasAttribute('data-ped-att-locked')).toBe(false);
  });
});
