import type { WebmailAdapter } from './types';

// TODO(T7): implement against saved HTML fixtures.
const HOSTS = new Set(['outlook.live.com', 'outlook.office.com', 'outlook.office365.com']);
export const outlook: WebmailAdapter = {
  name: 'outlook',
  matches: (url) => HOSTS.has(url.hostname),
  extract: () => null,
};
