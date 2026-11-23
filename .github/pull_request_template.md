## Summary
<!-- What does this PR change and why? -->

## Checklist
- [ ] `cd extension && npm run typecheck && npm test && npm run build:all` passes
- [ ] `cd ml && uv run pytest` passes (and `parity.json` updated if features changed)
- [ ] Privacy & minimal-permission guarantees in `AGENTS.md` and `docs/privacy.md` preserved (zero `innerHTML` with email data, zero new runtime dependencies, `<500 KB` bundle)
- [ ] Tests use synthetic fixtures only (no real personal emails or live phishing URLs)
