import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Production code must never depend on the mock model server.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/mock-model/*', '**/mock-model'], message: 'Only tests may import mock-model.' },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**', 'src/mock-model/**'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
