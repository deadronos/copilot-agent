# copilot-agent

Telegram bot powered by the GitHub Copilot SDK. BYOK provider system (GitHub, OpenAI, Anthropic, Ollama, anything OpenAI-compatible). TypeScript on Node 24, ESM.


> [!IMPORTANT]
> **CHANGELOG.md is updated on every change.** Add a single bullet per logical change (one entry per line) under `## Unreleased`, or under the current version header if a release is in progress. Be granular — one bullet per change, not one per commit or per PR.
>
> **Docs ↔ code parity is mandatory.** Whenever you touch `src/`, also read the matching `docs/ARCHITECTURE/00X-*.md` and check both directions:
>
> - **Codebase → docs:** if you change a behavior, command, schema field, or module boundary, the corresponding doc must be updated in the same change.
> - **Docs → codebase:** if a doc specifies a behavior the code doesn't actually implement (or implements differently), the codebase is the source of truth — fix the code, then either delete the stale doc text or rewrite it to match reality. Never leave docs lying about what the code does.
>
> When in doubt about which side to align, ask: "What would surprise a new contributor more — out-of-date docs or a doc that no longer matches the code?" The answer is always to fix both sides to agree.

## Adding a feature

1. **Pick the layer:** Telegram command handler, session manager, permission gate, agent loader, or config schema — each has one owner file.
2. **Implement + add a test** in `src/*.test.ts`. Follow the existing vitest patterns.
3. **Update `docs/ARCHITECTURE/00X-*.md`** if user-facing behavior, the config schema, or module boundaries change.
4. **Add a granular CHANGELOG.md entry** — one bullet per logical change under `## Unreleased` (or the current version header).
5. **Run `npm run typecheck && npm run lint && npm test`.**
