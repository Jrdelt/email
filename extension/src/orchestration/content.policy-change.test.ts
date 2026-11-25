// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C21: privacy settings changed while an email is open (entrypoints/content.ts storageChangeAffectsVerdicts). The
// user's Strict Local Mode (storage.local "privacySettings") and an enterprise policy pushed by IT (storage.managed
// "strictLocalMode") both re-evaluate the open email at once: turning Strict Local Mode off looks up the sender's
// domain that was skipped, and a policy that turns it on stops lookups and shows the verdict as checked offline,
// although the email itself did not change.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Msg,
  bootContent,
  fakeBrowser,
  gmailMessage,
  lastVerdict,
  lookups,
  quietly,
  settled,
  until,
} from './harness';

const PAGE = gmailMessage({
  name: 'Jordan Lee',
  email: 'jordan@northwind.example',
  subject: 'Agenda',
  body: `Hi team, the <a id="link" href="https://northwind.example/agenda">agenda</a> for Tuesday is on the wiki.`,
});

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: () => fakeBrowser.storage.local.set({ privacySettings: { strictLocalMode: true } }),
  }));
  await quietly(until(() => expect(lastVerdict(sent)).toBeTruthy()));
});

describe('content.ts: privacy settings changed while an email is open', () => {
  it('starts in Strict Local Mode: checked offline, no lookup', () => {
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, intel: 'offline' });
    expect(lookups(sent)).toEqual([]);
  });

  it('looks up the sender domain once the user turns Strict Local Mode off (local privacySettings)', async () => {
    const mark = sent.length;
    await fakeBrowser.storage.local.set({ privacySettings: { strictLocalMode: false } });
    await until(() =>
      expect(lookups(sent, mark), 'sender lookup after the setting changed').toEqual(['northwind.example']),
    );
    await settled(sent, mark);
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, intel: 'unavailable' });
  });

  it('stops lookups and re-renders offline when an IT policy enforces Strict Local Mode (managed)', async () => {
    const mark = sent.length;
    await fakeBrowser.storage.managed.set({ strictLocalMode: true });
    await until(() =>
      expect(lastVerdict(sent.slice(mark)), 'verdict after the policy changed').toMatchObject({ intel: 'offline' }),
    );
    expect(lookups(sent, mark)).toEqual([]);
  });
});
