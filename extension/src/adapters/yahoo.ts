import type { WebmailAdapter } from './types';

// TODO(T7): implement against saved HTML fixtures.
export const yahoo: WebmailAdapter = {
  name: 'yahoo',
  matches: (url) => url.hostname === 'mail.yahoo.com',
  extract: () => null,
};
