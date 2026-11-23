import type { WebmailAdapter } from './types';

// TODO(T7): implement against saved HTML fixtures.
export const gmail: WebmailAdapter = {
  name: 'gmail',
  matches: (url) => url.hostname === 'mail.google.com',
  extract: () => null,
};
