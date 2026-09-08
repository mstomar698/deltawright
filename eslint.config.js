// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'dist/',
      'test-results/',
      'playwright-report/',
      'bench/corpus/**',
      '.claude/worktrees/',
      'examples/', // standalone runnable examples with their own deps/tsconfig — not part of the lib build
      'docs/research/', // Research working trees. Only the deep-read BRIEFS (.md) are committed; the
      // rest of the tree stays local and holds fetched papers plus vendored upstream source (X-PERT,
      // ReDeCheck, Playwright internals) read as evidence and quoted in those briefs. Linting
      // third-party code we deliberately did not author says nothing about this library, and it
      // otherwise fails `npm run lint` for anyone with that tree checked out. Prettier already ignores
      // `docs` wholesale.
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The injected script runs in the page (browser globals); the host runs in
    // Node. Allow both everywhere — v0.1 keeps the two clearly separated by file.
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // We intentionally cast `window` / Web Animations internals to any at the
      // injected-script boundary; the delta types keep the public surface typed.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  prettier,
);
