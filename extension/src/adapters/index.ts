import { gmail } from './gmail';
import { outlook } from './outlook';
import type { WebmailAdapter } from './types';

export const adapters: WebmailAdapter[] = [gmail, outlook];
export const adapterFor = (url: URL) => adapters.find((a) => a.matches(url));
