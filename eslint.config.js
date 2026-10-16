import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '.data/**',
      'packages/database/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'error',
      // Spec section 18/53: no binary floating point for money. Domain code must use Decimal.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'parseFloat is forbidden: use a decimal library for monetary values.',
        },
      ],
    },
  },
  {
    // Scripts and tests may print to the console.
    files: ['scripts/**', 'tests/**', 'prisma/seed/**', '**/*.test.ts', '**/*.test.tsx'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
