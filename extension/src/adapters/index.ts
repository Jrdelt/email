import { gmail } from './gmail';
import { icloud } from './icloud';
import { outlook } from './outlook';
import { proton } from './proton';
import { yahoo } from './yahoo';
import type { WebmailAdapter } from './types';

export const adapters: WebmailAdapter[] = [gmail, outlook, yahoo, proton, icloud];
export const adapterFor = (url: URL) => adapters.find((a) => a.matches(url));
