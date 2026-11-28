import { defineConfig } from 'wxt';
import { splitContentScripts } from './src/contentScriptSplit';
import { WEBMAIL_MATCHES } from './src/hosts';

const ICONS = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};

export default defineConfig({
  hooks: {
    // One content.js, two manifest entries (top frame on standard webmail, all frames on iCloud's mail frames).
    'build:manifestGenerated': (_wxt, manifest) => {
      manifest.content_scripts = splitContentScripts(manifest.content_scripts);
    },
    // Firefox ignores storage.managed_schema (policies come from policies.json), so don't ship the schema there.
    'build:publicAssets': (wxt, files) => {
      if (wxt.config.browser !== 'firefox') return;
      const i = files.findIndex((f) => f.relativeDest === 'managed_schema.json');
      if (i !== -1) files.splice(i, 1);
    },
  },
  manifest: ({ browser }) => ({
    name: 'Phishing Email Detector',
    description:
      'Warns about phishing in webmail. Email content stays in your browser; only sender and clicked link domains are checked.',
    homepage_url: 'https://github.com/Jrdelt/email',
    icons: ICONS,
    action: {
      default_icon: ICONS,
    },
    permissions: ['storage'],
    host_permissions: WEBMAIL_MATCHES,
    ...(browser !== 'firefox'
      ? {
          storage: {
            managed_schema: 'managed_schema.json',
          },
        }
      : {}),
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none';",
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'phishing-email-detector@jrdelt.github.io',
              strict_min_version: '142.0',
              // Declared conservatively: the sender's domain (from an email) and the destination domains of clicked
              // links and submitted forms (browsing activity) go to public RDAP/DNS unless Strict Local Mode is on. See docs/browser-support-and-stores.md.
              data_collection_permissions: {
                required: ['websiteContent', 'browsingActivity', 'personalCommunications'],
              },
            },
          },
        }
      : {}),
  }),
});
