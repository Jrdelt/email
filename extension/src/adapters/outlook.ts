import type { WebmailAdapter } from './types';

// TODO(T7): implement against saved HTML fixtures.
export const outlook: WebmailAdapter = {
  name: 'outlook',
  matches: (url) => url.hostname === 'outlook.live.com' || url.hostname === 'outlook.office.com',
  extract: () => null,
};
