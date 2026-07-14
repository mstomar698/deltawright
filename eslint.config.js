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
