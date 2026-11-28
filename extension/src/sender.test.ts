import { describe, expect, it } from 'vitest';
import { registrableDomain } from './domain';
import { analyzeSender, canTrustByAllowlist } from './sender';

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

  it('flags suspicious via relays and unauthenticated senders while allowing known ESP relays', () => {
    const suspicious = analyzeSender('GmailSupportTeam', 'alert@nozfr.itl', [], {
      viaDomain: '442.320397.jnc7.one.bss0019.narodaro.my.id',
    });
    expect(suspicious.authIssue).toBe(true);
    expect(suspicious.warnings.join(' | ')).toMatch(/suspicious relay server \(my\.id\)/);
    expect(canTrustByAllowlist(suspicious)).toBe(false);

    const esp = analyzeSender('Shop Updates', 'news@shop.com', [], { viaDomain: 'em123.sendgrid.net' });
    expect(esp.authIssue).toBeUndefined();
    expect(esp.warnings).toEqual([]);
    expect(canTrustByAllowlist(esp)).toBe(true);

    const unauth = analyzeSender('Bank', 'alerts@bank.com', [], { unauthenticated: true });
    expect(unauth.unauthenticated).toBe(true);
    expect(unauth.authIssue).toBe(true);
    expect(unauth.warnings[0]).toMatch(/could not verify/);
    expect(canTrustByAllowlist(unauth)).toBe(false);

    const unknownVia = analyzeSender('Bank', 'alerts@bank.com', [], { viaDomain: 'evil-relay.example' });
    expect(canTrustByAllowlist(unknownVia)).toBe(false);
  });
});

describe('brand claims in the brand\'s own spelling', () => {
  const w = (n: string, a: string) => analyzeSender(n, a, []).warnings;
  it('flags camelCase brand names used alone or with service words', () => {
    for (const name of ['PayPal', 'Your PayPal Account', 'DocuSign', 'LinkedIn', 'FedEx', 'McAfee']) {
      expect(w(name, 'x@account-review.example').join(' ')).toMatch(/Claims to be/);
    }
    expect(w('PayPal', 'service@paypal.com')).toEqual([]);
    expect(w('Chase Smith', 'chase.smith@gmail.com')).toEqual([]);
  });
});

describe('country-code second-level domains', () => {
  it('keeps unrelated domains under com.pl apart, so a foreign relay blocks auto-trust', () => {
    expect(registrableDomain('mail.mybank.com.pl')).toBe('mybank.com.pl');
    expect(registrableDomain('www.bankhapoalim.co.il')).toBe('bankhapoalim.co.il');
    const s = analyzeSender('My Bank', 'alerts@mybank.com.pl', [], { viaDomain: 'mail.evil-relay.com.pl' });
    expect(s.viaDomain).toBe('mail.evil-relay.com.pl');
    expect(canTrustByAllowlist(s)).toBe(false);
    expect(canTrustByAllowlist(analyzeSender('My Bank', 'alerts@mybank.com.pl', [], { viaDomain: 'mta.mybank.com.pl' }))).toBe(true);
  });
});

describe('brand claims as the reader sees them', () => {
  it('catches soft hyphen, zero-width and fullwidth spellings of a brand in the display name', () => {
    for (const name of ['Pay­Pal Support', 'Pay​Pal Security', 'Pay⁠Pal', 'ＰａｙＰａｌ Service']) {
      const w = analyzeSender(name, 'alerts@secure-mail.example', []).warnings.join(' ');
      expect(w, name).toMatch(/Claims to be PayPal/);
    }
  });

  it("does not flag a brand's real regional sending domains as copies", () => {
    for (const [name, addr] of [
      ['PayPal', 'service@paypal.de'],
      ['PayPal Service', 'service@paypal.co.uk'],
      ['Amazon.fr', 'commande@amazon.fr'],
      ['Amazon', 'order@amazon.com.be'],
      ['DHL Paket', 'noreply@dhl.de'],
      ['DHL', 'info@dhl.co.il'],
    ]) {
      expect(analyzeSender(name!, addr!, []).warnings, addr).toEqual([]);
    }
    expect(analyzeSender('Service', 'alerts@paypal.xyz', []).warnings.join(' ')).toMatch(/looks like a copy of paypal\.com/);
  });
});

describe('a relay that cannot be checked', () => {
  // Gmail's "via" text under an IDN TLD (or any non-hostname text) used to be dropped as if there were no relay,
  // so a spoofed copy of a trusted address was auto-trusted. It now fails closed.
  it.each(['mailer.relay-hub.xn--p1ai', 'mailer.relay-hub.рф', 'relay_hub.example', 'mailer.relay-hub.xn--80asehdb.'])(
    'refuses auto-trust for via %s',
    (via) => {
      const s = analyzeSender('Alex Kim', 'alex@corp.example', [], { viaDomain: via });
      expect(s.authIssue).toBe(true);
      expect(canTrustByAllowlist(s)).toBe(false);
      expect(s.warnings.join(' | ')).toMatch(/relay server that could not be checked/);
    },
  );

  it('still trusts a sender with no relay or a known email service relay', () => {
    expect(canTrustByAllowlist(analyzeSender('Alex Kim', 'alex@corp.example', [], { viaDomain: '' }))).toBe(true);
    expect(canTrustByAllowlist(analyzeSender('Alex Kim', 'alex@corp.example', [], { viaDomain: '  ' }))).toBe(true);
    expect(canTrustByAllowlist(analyzeSender('Alex Kim', 'alex@corp.example', [], { viaDomain: 'em1.sendgrid.net' }))).toBe(true);
  });
});

describe("brand claims in the brands' own sender names", () => {
  // "Amazon.com", "Apple ID", "DHL Express"... carry no service word, so they used to pass as a person's name.
  const claims = (n: string, a = 'notice@mailer-evil.xyz') => analyzeSender(n, a, []).warnings.join(' | ');
  it.each([
    ['Amazon.com', 'Amazon'], ['Apple ID', 'Apple'], ['DHL Express', 'DHL'], ['Microsoft Outlook', 'Microsoft'],
    ['PayPal Inc.', 'PayPal'], ['paypal.com', 'PayPal'], ['www.paypal.com', 'PayPal'], ['IRS.gov', 'IRS'],
    ['Amazon Prime', 'Amazon'], ['Microsoft 365', 'Microsoft'], ['Chase Bank', 'Chase'], ['Google Workspace', 'Google'],
    ['amazon.co.uk', 'Amazon'], ['bankofamerica.com', 'Bank of America'], ['Apple Pay', 'Apple'],
  ])('%s from a stranger claims %s', (name, brand) => {
    expect(claims(name)).toContain(`Claims to be ${brand}, but was sent from mailer-evil.xyz`);
  });
  it.each([
    ['Amazon.com', 'auto-confirm@amazon.com'], ['Apple ID', 'appleid@id.apple.com'], ['DHL Express', 'noreply@dhl.com'],
    ['Microsoft 365', 'no-reply@microsoft.com'], ['PayPal Inc.', 'service@paypal.co.uk'], ['IRS.gov', 'x@irs.gov'],
    ['Chase Smith', 'chase.smith@gmail.com'], ['Chase Norton', 'chase.norton@gmail.com'], ['chasesmith', 'c@gmail.com'],
    ['Chase Smith (Acme Inc)', 'chase@acme.com'], ['Adobe Smith', 'a@x.com'], ['Olga Express Logistics', 'olga@logistics.example'],
    ['acme.com', 'news@acme.com'], ['www.example.org', 'hi@example.org'],
  ])('%s <%s> is not a claim', (name, addr) => {
    expect(claims(name, addr)).not.toMatch(/Claims to be/);
  });
});

describe('display names written with look-alike letters', () => {
  // NFKC keeps Cyrillic/Greek letters that look Latin, and look-alike dots were only folded in link text.
  it.each([
    ['PаyPаl Sеrvice', 'PayPal'], ['PаyPal Support', 'PayPal'], ['PаyPal', 'PayPal'], ['Аpple Support', 'Apple'],
    ['Micrоsoft account team', 'Microsoft'], ['Αmazon.com', 'Amazon'], ['paypalꓸcom', 'PayPal'],
  ])('%s claims %s', (name, brand) => {
    expect(analyzeSender(name, 'service@attacker.example', []).warnings.join(' | ')).toMatch(
      new RegExp(`Claims to be ${brand} using look-alike letters, but was sent from attacker\\.example`),
    );
  });
  it.each(['ceo@acme-corpꓸcom', 'ceo@acme-corp。com', 'ceo@acme-corp.сom', 'сeo@aсme-corp.com'])(
    '%s shows an address it was not sent from',
    (name) => {
      expect(analyzeSender(name, 'acme.ceo.office@gmail.com', []).warnings.join(' | ')).toMatch(
        /The display name shows ceo@acme-corp\.com, but it was really sent from acme\.ceo\.office@gmail\.com/,
      );
    },
  );
  it('leaves names in Cyrillic or Greek and a look-alike copy of the real address alone', () => {
    expect(analyzeSender('Иван Петров', 'ivan@post.example', []).warnings).toEqual([]);
    expect(analyzeSender('Сергей Иванов', 'sergey@post.example', []).warnings).toEqual([]);
    expect(analyzeSender('Ορέστης Παπαδόπουλος', 'orestis@example.gr', []).warnings).toEqual([]);
    expect(analyzeSender('аlex@corp.example', 'alex@corp.example', []).warnings).toEqual([]);
    expect(analyzeSender('PаyPal', 'service@paypal.com', []).warnings).toEqual([]);
  });
});
