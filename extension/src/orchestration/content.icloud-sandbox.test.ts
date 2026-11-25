// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://p55-mail.icloud-sandbox.com/applications/mail2-message/current/en-us/index.html"}
// C12: an iCloud sandbox message frame (entrypoints/content.ts runICloudSandbox). It cannot see the sender, so it
// reports its body (icloudBody, with a signature of that body) and applies the lock decision the app frame sends
// back through the background (icloudLock). Until a decision arrives, a click is held; a decision made for another
// body (different signature) is ignored. The app half is in content.icloud-app.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, deliver, navigations, tick, until } from './harness';

const PAGE = `<p>Your Apple ID is locked. Verify your password now or it will be suspended.</p>
  <a id="link" href="https://evil.example/login">www.apple.com</a>`;

let sent: Msg[];
let report: Msg;

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  report = await until(() => {
    const r = sent.find((m) => m.type === 'icloudBody' && m.active === true);
    expect(r).toBeDefined();
    return r!;
  });
});

const locked = () => document.body.hasAttribute('data-ped-locked');
const lock = (locked: boolean, sig: unknown) => deliver({ type: 'icloudLock', locked, attachmentsLocked: false, sig });

describe('content.ts: iCloud sandbox message frame', () => {
  it('reports its body, links and a body signature (no frame id: the background adds the verified one)', () => {
    expect(report).toMatchObject({
      type: 'icloudBody',
      active: true,
      links: [{ text: 'www.apple.com', href: 'https://evil.example/login' }],
      linksTruncated: false,
      attachmentNames: [],
    });
    expect(report.body).toContain('Verify your password');
    expect(report.sig).toMatch(/^[0-9a-f]+$/);
    expect(report).not.toHaveProperty('frameId');
  });

  it('holds a click until the decision arrives and drops it when the decision locks the frame', async () => {
    await tick(); // the scan that sent the report is over: only the missing decision can hold the click now
    expect(click($('link'))).toBe(true);
    await lock(false, 'deadbeef'); // a decision for another body must not release or unlock this one
    expect(locked()).toBe(false);
    await lock(true, report.sig);
    expect(locked()).toBe(true);
    expect($('link').hasAttribute('href')).toBe(false);
    await until(() => expect(document.getElementById('ped-toast-host')).not.toBeNull());
    await tick();
    expect(navigations(sent)).toEqual([]);
  });

  it('cancels clicks on the locked frame and asks the app frame to show its banner again', () => {
    const mark = sent.length;
    expect(click($('link'))).toBe(true);
    expect(sent.slice(mark)).toContainEqual({ type: 'icloudBlocked' });
    expect(navigations(sent)).toEqual([]);
  });

  it('ignores an unlock made for another body, and applies one made for this body', async () => {
    await lock(false, 'deadbeef');
    expect(locked()).toBe(true);
    await lock(false, report.sig);
    expect(locked()).toBe(false);
    expect($('link').getAttribute('href')).toBe('https://evil.example/login');
  });
});
