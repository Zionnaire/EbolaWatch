import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'src/contracts'] },
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // the Frontend never reaches into the Backend; contracts come through `pnpm sync:contracts`
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/Backend/**', '../../Backend/**'], message: 'Use src/contracts.' }] },
      ],
    },
  },
);
