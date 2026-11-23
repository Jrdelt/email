import { describe, expect, it } from 'vitest';
import { registrableDomain } from './domain';
import { analyzeSender } from './sender';

const w = (name: string, addr: string, links: { text: string; href: string }[] = []) => analyzeSender(name, addr, links).warnings;

describe('registrableDomain', () => {
  it.each([['mail.paypal.com', 'paypal.com'], ['a.b.example.co.uk', 'example.co.uk'], ['x.com', 'x.com']])('%s -> %s', (h, d) =>
    expect(registrableDomain(h)).toBe(d));
});

describe('analyzeSender', () => {
  it('no warnings for a normal sender', () => {
    expect(w('PayPal', 'service@paypal.com')).toEqual([]);
    expect(w('Chase Smith', 'chase.smith@gmail.com')).toEqual([]); // a person named Chase is not a brand claim
  });
  it('unknown sender produces no warnings', () => expect(w('', '')).toEqual([]));
  it('invalid address warns, does not throw or block', () => {
    const s = analyzeSender('X', 'bad..addr@example.com', []);
    expect(s.valid).toBe(false);
    expect(s.domain).toBe('example.com');
    expect(s.warnings[0]).toMatch(/invalid or forged/);
  });
  it('brand name from the wrong domain (including concatenated names)', () => {
    expect(w('PayPal Support', 'help@gmail.com')[0]).toMatch(/Claims to be PayPal, but was sent from gmail\.com/);
    expect(w('GmailSupportTeam', 'alert-442-320397@nozfr.itl')[0]).toMatch(/Claims to be Gmail, but was sent from nozfr\.itl/);
    expect(w('gmailsupportteam', 'x@evil.example')[0]).toMatch(/Claims to be Gmail, but was sent from evil\.example/);
    expect(w('PayPalSupport', 'x@evil.example')[0]).toMatch(/Claims to be PayPal, but was sent from evil\.example/);
    expect(w('iCloudSecurity', 'x@evil.example')[0]).toMatch(/Claims to be iCloud, but was sent from evil\.example/);
    expect(w('chasesmith', 'chase.smith@gmail.com')).toEqual([]);
  });
  it('display name containing a different address', () => expect(w('service@paypal.com', 'x@evil.example')[0]).toMatch(/really sent from x@evil\.example/));
  it.each([['security@paypa1.com', 'paypal.com'], ['a@rnicrosoft.com', 'microsoft.com'], ['a@paypal-secure.com', null], ['a@paypal.co', 'paypal.com']])(
    'lookalike %s', (addr, like) => {
      const ws = w('Someone', addr).join(' ');
      if (like) expect(ws).toContain(`looks like a copy of ${like}`); else expect(ws).not.toContain('looks like a copy of');
    });
  it('international domain', () => expect(w('A', 'a@xn--pple-43d.com').join(' ')).toMatch(/lookalike characters/));
  it('collects other link domains', () => {
    expect(analyzeSender('A', 'a@shop.com', [{ text: 'x', href: 'https://track.other.net/a' }, { text: 'y', href: 'https://www.shop.com' }]).linkDomains).toEqual(['other.net']);
  });
});
