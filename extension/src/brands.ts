// Commonly impersonated brands and the domains they really send from. Keep small; extend with data later.
export interface Brand { name: string; pattern: RegExp; domains: string[] }

const b = (name: string, domains: string[], pattern = new RegExp(`\\b${name.replace(/ /g, '\\s*')}\\b`, 'i')): Brand => ({ name, pattern, domains });

export const BRANDS: Brand[] = [
  b('PayPal', ['paypal.com']),
  b('Apple', ['apple.com', 'icloud.com']),
  b('iCloud', ['apple.com', 'icloud.com', 'me.com'], /\bi\s*cloud\b/i),
  b('Microsoft', ['microsoft.com', 'outlook.com', 'live.com', 'office.com', 'microsoftonline.com']),
  b('OneDrive', ['microsoft.com', 'live.com', 'outlook.com', 'office.com'], /\bone\s*drive\b/i),
  b('Outlook', ['microsoft.com', 'outlook.com', 'live.com', 'office.com']),
  b('Office 365', ['microsoft.com', 'office.com', 'microsoftonline.com']),
  b('Google', ['google.com', 'gmail.com', 'youtube.com']),
  b('Gmail', ['google.com', 'gmail.com']),
  b('Amazon', ['amazon.com', 'amazon.co.uk', 'amazon.ca', 'amazon.de', 'amazon.com.au']),
  b('Netflix', ['netflix.com']),
  b('Chase', ['chase.com', 'jpmorgan.com']),
  b('Bank of America', ['bankofamerica.com', 'bofa.com']),
  b('Wells Fargo', ['wellsfargo.com']),
  b('DHL', ['dhl.com']),
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

export const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'zoho.com',
]);
