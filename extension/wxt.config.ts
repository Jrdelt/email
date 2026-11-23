import { defineConfig } from 'wxt';
import { WEBMAIL_MATCHES } from './src/hosts';

export default defineConfig({
  manifest: {
    name: 'Phishing Email Detector',
    description: 'Warns about likely phishing emails in webmail. Analysis runs locally; nothing leaves your browser.',
    permissions: ['storage'],
    host_permissions: WEBMAIL_MATCHES,
    browser_specific_settings: {
      gecko: { id: 'phishing-email-detector@jrdelt.github.io', strict_min_version: '115.0' },
    },
  },
});
