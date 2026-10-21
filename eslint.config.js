import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  ...tseslint.configs.recommended,
  {
    // core/ must stay pure: runnable in Node (future server), deterministic, no rendering or platform deps.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['phaser', 'phaser/*'], message: 'core/ must not depend on Phaser.' },
            { group: ['**/render/**', '**/platform/**', '**/save/**'], message: 'core/ must not import render/, platform/ or save/.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'localStorage', 'sessionStorage', 'performance', 'requestAnimationFrame', 'navigator'].map((name) => ({
          name,
          message: 'core/ must not use browser globals.',
        })),
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded RNG from core/rng.ts.' },
        { object: 'Date', property: 'now', message: 'core/ logic must not read wall-clock time; pass dt explicitly.' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date']", message: 'core/ logic must not read wall-clock time.' },
      ],
    },
  },
);
