# ADR 008: ESLint 9 Flat Config + Prettier 3 for Code Quality

**Status:** Accepted  
**Date:** 2026-06-04  
**Deciders:** @deadronos

## Context

The project reached ~600 lines of TypeScript across 10 source files and had no linting or formatting infrastructure. Manual code review for style consistency and potential bugs (unused variables, `any` casts, non-null assertions) was becoming unsustainable.

## Decision

**Adopt ESLint 9 with flat config, the TypeScript ESLint recommended rule set (non-type-aware), and Prettier 3 for formatting.**

Configuration (`eslint.config.js`):
```javascript
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.log', '.env*'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_'
      }],
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports', fixStyle: 'inline-type-imports'
      }],
      '@typescript-eslint/no-non-null-assertion': 'warn',
    },
  },
  {
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettierConfig,  // MUST be last
);
```

Prettier configuration (`.prettierrc.json`):
```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "semi": true,
  "endOfLine": "lf"
}
```

Key design choices:

1. **Non-type-aware linting.** We deliberately start with `tseslint.configs.recommended` (not `recommendedTypeChecked`). Type-aware linting requires `parserOptions.projectService`, which in turn requires all linted files (including `*.test.ts`) to be in `tsconfig.json` — but our `tsconfig.json` excludes test files from the build. This keeps the setup simple; type-aware rules can be opted into later.

2. **`_` prefix for unused vars.** `no-unused-vars` is set to `error`, but variables prefixed with `_` are ignored. This allows intentional placeholder parameters (e.g., `_invocation: { sessionId: string }`) without `// eslint-disable` comments.

3. **Inline type imports enforced.** `consistent-type-imports` with `fixStyle: 'inline-type-imports'` ensures type-only imports use `import type { ... }` syntax. This makes it clear which imports are erased at compile time and enables future optimizations.

4. **Non-null assertions are warnings, not errors.** `!` is sometimes the clearest expression of intent (e.g., `this.sessions.get(chatId)!` after a guard). We allow it but flag it so it's deliberate.

5. **Tests get looser rules.** Tests use vitest globals and sometimes need `any` for test fixtures. Relaxing rules in test files avoids false positives without reducing strictness in production code.

6. **Prettier configured last.** The `eslint-config-prettier` plugin disables ESLint formatting rules that conflict with Prettier. It must be the last entry in the config array to properly override all preceding rules.

## Rationale

1. **Flat config is the future of ESLint.** The `.eslintrc` format is deprecated. Flat config is the only format for ESLint 9+.
2. **`typescript-eslint` is the standard for TypeScript linting.** The `tseslint.config()` helper composes flat configs correctly.
3. **Starting with non-type-aware rules is pragmatic.** Type-aware linting adds significant compilation overhead and configuration complexity. The non-type-aware recommended rules catch 80% of common issues (unused vars, missing return types, `any` casts) without the overhead.
4. **Prettier eliminates formatting debates.** Auto-formatted code means no style nits in code review. Combined with ESLint (which catches bugs, not style), we get comprehensive coverage.
5. **Inline type imports are a clarity win.** `import type { SessionEntry }` immediately tells readers that `SessionEntry` is only used for type checking. It also enables `verbatimModuleSyntax` if we ever opt into it.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Biome (all-in-one linter + formatter) | Less mature TypeScript support. The ecosystem (VS Code extensions, CI integrations) is centered on ESLint + Prettier. |
| ESLint with `.eslintrc` format | Deprecated. New ESLint versions don't support it without legacy config. |
| Type-aware linting from day one | Requires including test files in `tsconfig.json`, complicating the build. Incremental adoption is better. |
| `deno lint` / `deno fmt` | Would require migrating the entire project to Deno. Out of scope. |
| No formatter, ESLint-only | ESLint's formatting rules are intentionally limited. Prettier produces more consistent output for the formatting-only concerns that ESLint doesn't handle well. |

## Consequences

### Positive
- All code follows a consistent style (single quotes, trailing commas, 100-char width)
- Unused variables, `any` casts, and non-null assertions are surfaced by lint
- Type imports are clearly distinguished from value imports
- The `_` prefix convention is enforced by lint, not just convention
- Prettier runs on save via editor integration or `npm run format`

### Negative
- The non-type-aware lint setup won't catch type-related issues like `no-unsafe-argument` or `no-floating-promises`
- Adding a new file requires following the lint rules (which is the point, but adds friction for prototypes)
- The `warn` level for non-null assertions may encourage overuse — should eventually be tightened to `error`

### Mitigations
- `npm run typecheck` (standalone `tsc --noEmit`) catches type errors that non-type-aware linting misses
- `npm run lint:fix` auto-fixes many issues (unused imports, type import style)
- The `warn` level for non-null assertions can be tightened to `error` once the codebase stabilizes
