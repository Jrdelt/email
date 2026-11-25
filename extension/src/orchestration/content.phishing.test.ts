// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C1: entrypoints/content.ts on a fake Gmail page showing a phishing email. The user clicks its link before the
// first (debounced) scan has run; that click is held, then dropped once the scan locks the email. The verdict
// reaches the background and every later attempt to follow a link is cancelled, including links added afterwards.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, gmailMessage, lastVerdict, press, settled, tick, verdictsOf } from './harness';

const PAGE = gmailMessage({
  name: 'PayPal Support',
  email: 'help@paypa1-secure.example',
  subject: 'Account notice',
  body: `Your PayPal account is locked. Verify your password now or it will be suspended.
    <a id="link" href="https://evil.example/login">www.paypal.com</a>`,
});

let sent: Msg[];
let verdictsBeforeEarlyClick: number;
let earlyClickCancelled: boolean;

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  verdictsBeforeEarlyClick = verdictsOf(sent).length;
  earlyClickCancelled = click($('link')); // the first scan is still waiting out its 400 ms debounce
  await settled(sent);
});

const body = () => document.querySelector<HTMLElement>('div.a3s')!;
const navigations = () => sent.filter((m) => m.type === 'openSafeLink' || m.type === 'openWarning');

describe('content.ts: phishing email in Gmail', () => {
  it('holds a click made before the first scan, then drops it once the scan locks the email', () => {
    expect(verdictsBeforeEarlyClick).toBe(0);
    expect(earlyClickCancelled).toBe(true);
    expect(navigations()).toEqual([]); // neither opened through the background nor sent to the warning page
    expect(document.getElementById('ped-toast-host')).not.toBeNull(); // "link paused" notice
  });

  it('sends a non-safe verdict to the background and looks up only the sender registrable domain', () => {
    expect(lastVerdict(sent)).toMatchObject({
      verdict: { level: 'likely-phishing' },
      sender: { address: 'help@paypa1-secure.example' },
      trusted: false,
    });
    expect(sent.filter((m) => m.type === 'domainIntel').map((m) => m.domain)).toEqual(['paypa1-secure.example']);
  });

  it('shows the warning banner and pauses the body: href stashed, clicks and Enter cancelled', () => {
    expect(document.getElementById('ped-banner-host')).not.toBeNull();
    expect(body().hasAttribute('data-ped-locked')).toBe(true);
    const link = $('link');
    expect(link.hasAttribute('href')).toBe(false);
    expect(link.getAttribute('data-ped-href')).toBe('https://evil.example/login');
    expect(click(link)).toBe(true);
    expect(click(link, { ctrlKey: true })).toBe(true);
    expect(press(link, 'Enter')).toBe(true);
    expect(navigations()).toEqual([]);
  });

  it('pauses a link the page adds to the locked body afterwards, before any rescan', async () => {
    const mark = sent.length;
    body().insertAdjacentHTML('beforeend', '<a id="late" href="https://evil.example/step2">Continue</a>');
    // The lock's own MutationObserver stashes it at once; the rescan the mutation schedules is 400 ms away.
    await tick();
    expect(verdictsOf(sent.slice(mark))).toEqual([]);
    expect($('late').hasAttribute('href')).toBe(false);
    expect($('late').getAttribute('data-ped-href')).toBe('https://evil.example/step2');
    expect(click($('late'))).toBe(true);
    await settled(sent, mark); // the rescan triggered by the new link keeps the email locked
    expect(body().hasAttribute('data-ped-locked')).toBe(true);
    expect(click($('late'))).toBe(true);
    expect(navigations()).toEqual([]);
  });
});
