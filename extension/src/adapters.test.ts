import { describe, expect, it } from 'vitest';
import { adapterFor } from './adapters';
import { WEBMAIL_MATCHES } from './hosts';

describe('adapters', () => {
  it.each([
    ['https://mail.google.com/mail/u/0/', 'gmail'],
    ['https://outlook.live.com/mail/0/', 'outlook'],
    ['https://outlook.office.com/mail/', 'outlook'],
    ['https://outlook.office365.com/mail/', 'outlook'],
    ['https://outlook.cloud.microsoft/mail/0/', 'outlook'],
    ['https://mail.yahoo.com/d/folders/1', 'yahoo'],
    ['https://mail.proton.me/u/0/inbox', 'proton'],
    ['https://www.icloud.com/mail/', 'icloud'],
    ['https://www.icloud.com/applications/mail2/current/en-us/index.html', 'icloud'],
    ['https://www-mail.icloud-sandbox.com/applications/mail2-message/current/en-us/index.html', 'icloud'],
  ])('routes %s to %s', (url, name) => {
    expect(adapterFor(new URL(url))?.name).toBe(name);
  });
  it('ignores unsupported pages', () => {
    expect(adapterFor(new URL('https://example.com'))).toBeUndefined();
    expect(adapterFor(new URL('https://www.icloud.com/photos/'))).toBeUndefined();
    expect(adapterFor(new URL('https://evil-icloud-sandbox.com/applications/mail2-message/'))).toBeUndefined();
  });
  it('every match pattern host has an adapter', () => {
    for (const m of WEBMAIL_MATCHES) {
      expect(adapterFor(new URL(m.replace('*.', 'www-mail.').replace(/\*/g, ''))), m).toBeDefined();
    }
  });
  it.todo('T7: each adapter extracts sender/body/links from fixture HTML');
  it.todo('T6: model falls back to heuristics when the model fails to load');
});
