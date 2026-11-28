// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://p55-mail.icloud-sandbox.com/applications/mail2-message/current/en-us/index.html"}
// A pooled iCloud message frame ties each lock decision to the body it was made for by a signature of that body. The
// signature must not be forgeable from email content: with a 32-bit FNV-1a (invertible), the author of a benign email
// A could pad a phishing email B with six letters so that B gets A's signature. A's unlock (re-sent by the app frame
// as soon as the frame reports a body with that signature, or arriving late) would then unlock B and release its held
// clicks before B is scored.
import { beforeAll, describe, expect, it } from 'vitest';
import { extractICloudSandbox } from '../adapters/icloud';
import { $, type Msg, bootContent, click, deliver, navigations, tick, until } from './harness';

const PAGE_A = `<p>Your order 1042 has shipped. Track it on our website.</p>
  <a id="link" href="https://shop.example/track/1042">Track your parcel</a>`;
const pageB = (pad: string) => `<p>Your Apple ID is locked. Verify your password now or it will be suspended.
  Reference ${pad}</p>
  <a id="link" href="https://evil.example/login">www.apple.com</a>`;

// FNV-1a over UTF-16 code units, as an attacker would compute it.
const PRIME = 0x01000193;
const step = (h: number, c: number) => Math.imul(h ^ c, PRIME) >>> 0;
const fnv = (s: string, h = 0x811c9dc5) => {
  for (let i = 0; i < s.length; i++) h = step(h, s.charCodeAt(i));
  return h >>> 0;
};
const PRIME_INV = (() => {
  let x = PRIME; // Newton's iteration for the inverse of an odd number modulo 2^32
  for (let i = 0; i < 5; i++) x = Math.imul(x, 2 - Math.imul(PRIME, x)) >>> 0;
  return x;
})();
const unstep = (h: number, c: number) => (Math.imul(h, PRIME_INV) ^ c) >>> 0;

/** Six letters X such that fnv(prefix + X + suffix) === target (meet in the middle over three letters each side). */
function forge(prefix: string, suffix: string, target: number): string {
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let need = target;
  for (let i = suffix.length - 1; i >= 0; i--) need = unstep(need, suffix.charCodeAt(i));
  const start = fnv(prefix);
  const forward = new Map<number, string>();
  for (const a of letters) for (const b of letters) for (const c of letters) {
    forward.set(step(step(step(start, a.charCodeAt(0)), b.charCodeAt(0)), c.charCodeAt(0)), a + b + c);
  }
  for (const a of letters) for (const b of letters) for (const c of letters) {
    const mid = unstep(unstep(unstep(need, c.charCodeAt(0)), b.charCodeAt(0)), a.charCodeAt(0));
    const head = forward.get(mid);
    if (head) return head + a + b + c;
  }
  throw new Error('no collision found');
}

/** The string the sandbox signed before this fix. */
const signedString = () => {
  const { active, body, links, linksTruncated = false, attachments } = extractICloudSandbox(document);
  return JSON.stringify({ active, body, links, linksTruncated, attachmentNames: attachments.map((a) => a.name) });
};

let sent: Msg[];
const reports = () => sent.filter((m) => m.type === 'icloudBody' && m.active === true);

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE_A));
  await until(() => expect(reports()).toHaveLength(1));
  await tick();
});

describe('content.ts: iCloud sandbox body signature', () => {
  it("a body padded to collide with an earlier body's FNV-1a gets its own signature", async () => {
    const [reportA] = reports();
    const fnvA = fnv(signedString());
    // A is benign: the app frame unlocks it.
    await deliver({ type: 'icloudLock', locked: false, attachmentsLocked: false, sig: reportA!.sig });

    // The same pooled frame now shows the attacker's B, padded so that its FNV-1a equals A's.
    document.body.innerHTML = pageB('QQQQQQ');
    const json = signedString();
    const at = json.indexOf('QQQQQQ');
    const pad = forge(json.slice(0, at), json.slice(at + 6), fnvA);
    document.body.innerHTML = pageB(pad);
    expect(fnv(signedString()), 'the forged body collides under FNV-1a').toBe(fnvA);

    const reportB = await until(() => {
      const r = reports().find((m) => String(m.body).includes('Apple ID'));
      expect(r).toBeDefined();
      return r!;
    });
    expect(reportB.sig).toMatch(/^[0-9a-f]{32}$/);
    expect(reportB.sig, "B's signature").not.toBe(reportA!.sig);

    // B is not scored yet: a click is held. A's unlock (re-sent or late) must neither unlock nor release it.
    const mark = sent.length;
    expect(click($('link')), 'click held').toBe(true);
    await deliver({ type: 'icloudLock', locked: false, attachmentsLocked: false, sig: reportA!.sig });
    await new Promise((r) => setTimeout(r, 100));
    expect(navigations(sent, mark), 'no navigation on the strength of A').toEqual([]);

    // B's own decision locks it; the held click is dropped.
    await deliver({ type: 'icloudLock', locked: true, attachmentsLocked: false, sig: reportB.sig });
    expect(document.body.hasAttribute('data-ped-locked')).toBe(true);
    await tick();
    expect(navigations(sent, mark)).toEqual([]);
  });
});
