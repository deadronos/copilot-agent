// ESLint flat config for copilot-agent.
// Stack:
//   - typescript-eslint: TypeScript linting
//   - eslint-config-prettier: disables ESLint rules that conflict with Prettier
//
// We start with the non-type-aware recommended config for a low-friction setup.
// To opt into stricter type-aware rules later, add `recommendedTypeChecked` to
// the array and configure `parserOptions.projectService`. That will require
// including `*.test.ts` in `tsconfig.json` (currently excluded from the build).
//
// See https://eslint.org/docs/latest/use/configure/configuration-files
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Global ignores — apply to all configs below.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.log', '.env*'],
  },

  // TypeScript recommended rules for all source files.
  ...tseslint.configs.recommended,

  // Project-specific overrides. Keep this list small and intentional.
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        // Unused vars prefixed with `_` are intentional placeholders.
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Allow non-null assertions where they are genuinely clearer than a guard.
      // Tighten to 'error' if the team wants to forbid them.
      '@typescript-eslint/no-non-null-assertion': 'warn',
    },
  },

  // Tests get slightly looser defaults; vitest globals are used heavily.
  {
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // MUST be last: turns off ESLint rules that conflict with Prettier.
  prettierConfig,
);
