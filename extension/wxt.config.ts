import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Phishing Email Detector',
    description: 'Warns about likely phishing emails in webmail. Analysis runs locally; nothing leaves your browser.',
    permissions: ['storage'],
    host_permissions: [
      'https://mail.google.com/*',
      'https://outlook.live.com/*',
      'https://outlook.office.com/*',
    ],
    browser_specific_settings: {
      gecko: { id: 'phishing-email-detector@jrdelt.github.io', strict_min_version: '115.0' },
    },
  },
});
