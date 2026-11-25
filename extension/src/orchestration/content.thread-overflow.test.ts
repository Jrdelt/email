// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C16: a Gmail conversation with more open messages than entrypoints/content.ts scores (MAX_THREAD_MESSAGES, 20).
// The newest 20 come from an allowlisted colleague; the oldest one, beyond the cap, is phishing. It is never scored or
// looked up, so it fails closed: its links are paused behind a neutral "not fully checked" notice (an unchecked
// verdict, not a phishing one), while the trusted messages stay open. Its sender name claims no brand, so no sender
// warning could lock it either: only the overflow rule does.
import { beforeAll, describe, expect, it } from 'vitest';
import { scoreEmail } from '../features';
import {
  $,
  type Msg,
  bootContent,
  click,
  fakeBrowser,
  lastVerdict,
  lookups,
  navigations,
  quietly,
  until,
  verdictsOf,
} from './harness';

const TRUSTED = 'alex@corp.example';
const NEWEST = 20;
const PHISH = {
  email: 'billing@invoices-portal.example',
  text: 'Your mailbox is locked. Verify your password now or it will be suspended.',
  link: { text: 'Sign in', href: 'https://evil.example/login' },
};

const message = (o: { id: string; name: string; email: string; body: string }) =>
  `<div class="adn"><span class="gD" email="${o.email}" name="${o.name}">${o.name}</span>
    <div class="a3s" id="${o.id}">${o.body}</div></div>`;

const PAGE = `<h2 class="hP">Quarterly review</h2>
  ${message({
    id: 'oldest',
    name: 'Billing Team',
    email: PHISH.email,
    body: `${PHISH.text} <a id="phish" href="${PHISH.link.href}">${PHISH.link.text}</a>`,
  })}
  ${Array.from({ length: NEWEST }, (_, i) =>
    message({
      id: `m${i}`,
      name: 'Alex Kim',
      email: TRUSTED,
      body: `Update ${i}: notes are on the <a id="l${i}" href="https://corp.example/review/${i}">review page</a>.`,
    }),
  ).join('')}`;

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: () => fakeBrowser.storage.local.set({ trustedSenders: [TRUSTED] }),
  }));
  await quietly(until(() => expect(verdictsOf(sent).length).toBeGreaterThan(0)));
});

describe('content.ts: Gmail thread with more open messages than are scored', () => {
  it('reports the oldest message as unchecked, not scored: a neutral notice, no phishing verdict, no lookup', () => {
    const alone = scoreEmail(PHISH.email, PHISH.text, [PHISH.link]);
    expect(alone.level, 'the oldest message, scored on its own').not.toBe('safe');
    expect(lastVerdict(sent)).toMatchObject({
      verdict: {
        level: 'suspicious',
        unchecked: true,
        reasons: [
          'This conversation has too many open messages to check; links and attachments in the oldest 1 are paused',
        ],
      },
      sender: { address: PHISH.email, warnings: [] },
      trusted: false,
    });
    expect(lookups(sent), 'neither the overflow message nor the trusted ones are looked up').toEqual([]);
    expect(document.getElementById('ped-banner-host')).not.toBeNull();
  });

  it('locks the oldest message: href stashed, click cancelled', () => {
    expect($('oldest').hasAttribute('data-ped-locked'), 'oldest message locked').toBe(true);
    expect($('phish').hasAttribute('href')).toBe(false);
    expect(click($('phish'))).toBe(true);
    expect(navigations(sent)).toEqual([]);
  });

  it('leaves the 20 newest, allowlisted messages unlocked', () => {
    for (let i = 0; i < NEWEST; i++) expect($(`m${i}`).hasAttribute('data-ped-locked'), `message m${i}`).toBe(false);
    expect($('l19').getAttribute('href')).toBe('https://corp.example/review/19');
  });
});
