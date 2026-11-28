// Commonly impersonated brands and the domains they really send from. Keep small; extend with data later.
export interface Brand { name: string; pattern: RegExp; domains: string[] }

const b = (name: string, domains: string[], pattern = new RegExp(`\\b${name.replace(/ /g, '\\s*')}\\b`, 'i')): Brand => ({ name, pattern, domains });

export const BRANDS: Brand[] = [
  // Regional domains the brands really send from: their shared label must not read as a copy of the .com.
  b('PayPal', [
    'paypal.com', 'paypal.de', 'paypal.co.uk', 'paypal.fr', 'paypal.it', 'paypal.es', 'paypal.nl', 'paypal.at',
    'paypal.ch', 'paypal.be', 'paypal.pl', 'paypal.se', 'paypal.dk', 'paypal.no', 'paypal.ie', 'paypal.ca',
    'paypal.com.au', 'paypal.jp', 'paypal.com.br', 'paypal.com.mx',
  ]),
  b('Apple', ['apple.com', 'icloud.com']),
  b('iCloud', ['apple.com', 'icloud.com', 'me.com'], /\bi\s*cloud\b/i),
  b('Microsoft', ['microsoft.com', 'outlook.com', 'live.com', 'office.com', 'microsoftonline.com']),
  b('OneDrive', ['microsoft.com', 'live.com', 'outlook.com', 'office.com'], /\bone\s*drive\b/i),
  b('Outlook', ['microsoft.com', 'outlook.com', 'live.com', 'office.com']),
  b('Office 365', ['microsoft.com', 'office.com', 'microsoftonline.com']),
  b('Google', ['google.com', 'gmail.com', 'googlemail.com', 'youtube.com']),
  b('Gmail', ['google.com', 'gmail.com', 'googlemail.com']),
  b('Amazon', [
    'amazon.com', 'amazon.co.uk', 'amazon.ca', 'amazon.de', 'amazon.com.au', 'amazon.fr', 'amazon.it', 'amazon.es',
    'amazon.nl', 'amazon.se', 'amazon.pl', 'amazon.com.be', 'amazon.co.jp', 'amazon.in', 'amazon.com.mx',
    'amazon.com.br', 'amazon.com.tr', 'amazon.sa', 'amazon.ae', 'amazon.eg', 'amazon.sg', 'amazon.cn', 'primevideo.com',
  ]),
  b('Netflix', ['netflix.com']),
  b('Chase', ['chase.com', 'jpmorgan.com']),
  b('Bank of America', ['bankofamerica.com', 'bofa.com']),
  b('Wells Fargo', ['wellsfargo.com']),
  b('DHL', [
    'dhl.com', 'dhl.de', 'dhl.co.uk', 'dhl.fr', 'dhl.it', 'dhl.es', 'dhl.nl', 'dhl.at', 'dhl.ch', 'dhl.be',
    'dhl.com.pl', 'dhl.co.il',
  ]),
  b('FedEx', ['fedex.com']),
  b('UPS', ['ups.com']),
  b('USPS', ['usps.com']),
  b('IRS', ['irs.gov']),
  b('DocuSign', ['docusign.com', 'docusign.net']),
  b('Dropbox', ['dropbox.com', 'dropboxmail.com']),
  b('LinkedIn', ['linkedin.com']),
  b('Facebook', ['facebook.com', 'facebookmail.com', 'meta.com']),
  b('Instagram', ['instagram.com']),
  b('Coinbase', ['coinbase.com']),
  b('Stripe', ['stripe.com']),
  b('Venmo', ['venmo.com', 'paypal.com']),
  b('Cash App', ['cash.app', 'squareup.com', 'block.xyz']),
  b('Zelle', ['zellepay.com']),
  b('Adobe', ['adobe.com']),
  b('Norton', ['norton.com', 'nortonlifelock.com', 'gendigital.com']),
  b('McAfee', ['mcafee.com']),
  b('Geek Squad', ['bestbuy.com', 'geeksquad.com']),
];

const SERVICE_WORD_LIST = [
  'support', 'team', 'security', 'account', 'accounts', 'billing', 'service', 'services', 'alert', 'alerts',
  'notification', 'notifications', 'customer', 'help', 'helpdesk', 'admin', 'noreply', 'no-reply', 'verification',
  'payments?', 'delivery', 'cloud', 'storage', 'drive', 'mail', 'desk', 'center', 'protection', 'recovery',
  'update', 'notice', 'warning', 'subscription', 'invoice', 'order', 'care', 'official',
];

/** Words that make a display name look like an organisation rather than a person ("Chase Smith" vs "Chase Support"). */
export const SERVICE_WORDS = new RegExp(`\\b(?:${SERVICE_WORD_LIST.join('|')})\\b`, 'i');

/** Start-anchored version for all-lowercase concatenated display names like "gmailsupportteam". */
export const SERVICE_PREFIX = new RegExp(`^(?:${SERVICE_WORD_LIST.map((w) => w.replace(/-/g, '')).join('|')})`, 'i');

// Words a squatted sender domain adds to a brand: "paypal-secure", "appleid-verify", "amazonbilling",
// "securepaypal". Narrower than SERVICE_WORD_LIST: "center", "drive", "cloud", "storage", "order" and "desk" also
// name ordinary businesses ("chasecenter.com").
const DOMAIN_LURE_WORD_LIST = [
  'support', 'security', 'secure', 'account', 'accounts', 'billing', 'service', 'services', 'alert', 'alerts',
  'notification', 'notifications', 'customer', 'help', 'helpdesk', 'admin', 'noreply', 'verify', 'verification',
  'verified', 'payment', 'payments', 'delivery', 'recovery', 'update', 'notice', 'warning', 'subscription',
  'invoice', 'login', 'signin', 'auth', 'id', 'mail', 'team', 'care', 'official', 'protection', 'unlock', 'confirm',
  'refund', 'online',
];
const LURE_ALT = DOMAIN_LURE_WORD_LIST.join('|');
/** A whole domain token made of one or two lure words ("secure", "accountverify"). */
export const DOMAIN_LURE_RUN = new RegExp(`^(?:${LURE_ALT}){1,2}$`);
/** A domain token that starts with a lure word ("supportcenter"); only used after a distinctive brand. */
export const DOMAIN_LURE_START = new RegExp(`^(?:${LURE_ALT})`);

/**
 * Brand labels that are dictionary words or short abbreviations ("apple-orchard", "amazon-tours", "pickups"): in a
 * longer domain they only count next to a lure word ("apple-support", "dhl-delivery", "appleid").
 */
export const WORD_BRAND_LABELS: ReadonlySet<string> = new Set([
  'apple', 'amazon', 'chase', 'outlook', 'stripe', 'adobe', 'norton', 'meta', 'dhl', 'ups', 'irs', 'bofa',
]);
/**
 * Labels of secondary brand domains that are everyday words (me.com, live.com, office.com, cash.app, block.xyz):
 * only a domain whose whole label is (a look-alike of) them counts, never one that merely contains them.
 */
export const GENERIC_BRAND_LABELS: ReadonlySet<string> = new Set(['me', 'live', 'office', 'cash', 'block']);

/**
 * Words that, right after a brand, name the brand's own organisation or product rather than a person's surname:
 * "Amazon.com", "PayPal Inc.", "Apple ID", "DHL Express", "Microsoft 365" (but not "Chase Smith"). Only matched
 * directly after the brand, so "Chase Smith (Acme Inc)" stays a person. Legal and domain suffixes count for every
 * brand; product words only for the brand that has them, since many brands are ordinary words and other real
 * organisations share them ("Apple Bank" at applebank.com, "Chase Pro Tools", "Norton Pro").
 */
const ORG_WORD_LIST = ['com', 'net', 'org', 'gov', 'inc', 'llc', 'ltd', 'corp'];
const BRAND_PRODUCT_WORDS: Readonly<Record<string, readonly string[]>> = {
  Apple: ['id', 'pay', 'wallet', 'icloud'],
  Microsoft: ['365', 'outlook', 'office', 'teams', 'onedrive', 'online'],
  Outlook: ['online'],
  Google: ['workspace', 'pay', 'gmail', 'wallet'],
  Amazon: ['prime', 'pay'],
  Chase: ['bank', 'online'],
  'Bank of America': ['online'],
  'Wells Fargo': ['bank', 'online'],
  DHL: ['express'],
  FedEx: ['express'],
  Facebook: ['pay'],
  Coinbase: ['wallet', 'pro'],
  Zelle: ['pay'],
  Adobe: ['express', 'id'],
};

/** Per brand (same order as BRANDS): the brand followed by an organisation word or one of its own product words. */
export const BRAND_ORG_PATTERNS: readonly RegExp[] = BRANDS.map(
  (br) => new RegExp(`${br.pattern.source}\\s+(?:${[...ORG_WORD_LIST, ...(BRAND_PRODUCT_WORDS[br.name] ?? [])].join('|')})\\b`, 'i'),
);

export const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'zoho.com',
]);

/**
 * Legitimate third-party email service providers commonly shown in webmail "via" headers.
 * Entries must be registrable domains: lookups compare against registrableDomain(via).
 */
export const KNOWN_ESP_DOMAINS = new Set([
  'sendgrid.net', 'amazonses.com', 'mailgun.org', 'mailgun.net', 'postmarkapp.com', 'mcsv.net', 'mailchimpapp.net',
  'rsgsv.net', 'mcdlv.net', 'hubspotemail.net', 'sparkpostmail.com', 'mandrillapp.com', 'constantcontact.com',
  'exacttarget.com', 'salesforce.com', 'zendesk.com', 'freshdesk.com', 'klaviyomail.com',
  'googlegroups.com', 'intercom-mail.com', 'brevo.com', 'sendinblue.com',
]);
