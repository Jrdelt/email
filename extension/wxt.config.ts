import { defineConfig } from 'wxt';
import { WEBMAIL_MATCHES } from './src/hosts';

const ICONS = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};

export default defineConfig({
  manifest: {
    name: 'Phishing Email Detector',
    description: 'Warns about likely phishing emails in webmail. Email content never leaves your browser; only the sender domain is looked up.',
    icons: ICONS,
    action: {
      default_icon: ICONS,
    },
    permissions: ['storage'],
    host_permissions: WEBMAIL_MATCHES,
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none';",
    },
    browser_specific_settings: {
      gecko: { id: 'phishing-email-detector@jrdelt.github.io', strict_min_version: '115.0' },
    },
  },
});
