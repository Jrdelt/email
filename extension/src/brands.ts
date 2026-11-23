// Commonly impersonated brands and the domains they really send from. Keep small; extend with data later.
export interface Brand { name: string; pattern: RegExp; domains: string[] }

const b = (name: string, domains: string[], pattern = new RegExp(`\\b${name.replace(/ /g, '\\s*')}\\b`, 'i')): Brand => ({ name, pattern, domains });

export const BRANDS: Brand[] = [
  b('PayPal', ['paypal.com']),
  b('Apple', ['apple.com', 'icloud.com']),
  b('Microsoft', ['microsoft.com', 'outlook.com', 'live.com', 'office.com', 'microsoftonline.com']),
  b('Office 365', ['microsoft.com', 'office.com', 'microsoftonline.com']),
  b('Google', ['google.com', 'gmail.com', 'youtube.com']),
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
];

/** Words that make a display name look like an organisation rather than a person ("Chase Smith" vs "Chase Support"). */
export const SERVICE_WORDS = /\b(support|team|security|account|accounts|billing|service|services|alert|alerts|notification|notifications|customer|help|helpdesk|admin|noreply|no-reply|verification|payments?|delivery)\b/i;

export const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'zoho.com',
]);
