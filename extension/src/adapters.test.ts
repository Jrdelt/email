import { describe, expect, it } from 'vitest';
import { adapterFor } from './adapters';

describe('adapters', () => {
  it('routes by hostname', () => {
    expect(adapterFor(new URL('https://mail.google.com/mail/u/0/'))?.name).toBe('gmail');
    expect(adapterFor(new URL('https://outlook.office.com/mail/'))?.name).toBe('outlook');
    expect(adapterFor(new URL('https://example.com'))).toBeUndefined();
  });
  it.todo('T7: gmail adapter extracts sender/body/links from fixture HTML');
  it.todo('T7: outlook adapter extracts sender/body/links from fixture HTML');
  it.todo('T6: model falls back to heuristics when the model fails to load');
});
