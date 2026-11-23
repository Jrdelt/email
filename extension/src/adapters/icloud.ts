import type { WebmailAdapter } from './types';

// TODO(T7): implement against saved HTML fixtures.
// Note: iCloud Mail loads the mail app and message body in iframes; investigate frame access first.
export const icloud: WebmailAdapter = {
  name: 'icloud',
  matches: (url) => url.hostname === 'www.icloud.com' && url.pathname.startsWith('/mail'),
  extract: () => null,
};
