// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nonDeterministicMath = ['random', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'pow', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'sinh', 'cosh', 'tanh', 'cbrt', 'hypot'];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**', '.claude/**', 'public/sw.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
      'prefer-const': 'warn',
    },
  },
  // Determinism rules (ARCHITECTURE rule 1): sim and ai must be bit-identical across engines.
  {
    files: ['src/sim/**/*.ts', 'src/ai/**/*.ts'],
    ignores: ['src/sim/**/*.test.ts', 'src/ai/**/*.test.ts'],
    rules: {
      'no-restricted-properties': ['error',
        ...nonDeterministicMath.map((p) => ({ object: 'Math', property: p, message: 'Not deterministic across engines. Use src/sim/core/dmath.ts (or the seeded RNG in state).' })),
        { object: 'Date', property: 'now', message: 'No clocks inside sim/ai.' },
        { object: 'performance', property: 'now', message: 'No clocks inside sim/ai.' },
      ],
      'no-restricted-globals': ['error',
        { name: 'window', message: 'No DOM inside sim/ai.' },
        { name: 'document', message: 'No DOM inside sim/ai.' },
        { name: 'performance', message: 'No clocks inside sim/ai.' },
        { name: 'navigator', message: 'No platform access inside sim/ai.' },
        { name: 'localStorage', message: 'No storage inside sim/ai.' },
        { name: 'requestAnimationFrame', message: 'No frame loop inside sim/ai.' },
        { name: 'setTimeout', message: 'No timers inside sim/ai.' },
        { name: 'setInterval', message: 'No timers inside sim/ai.' },
      ],
      'no-restricted-syntax': ['error',
        { selector: "NewExpression[callee.name='Date']", message: 'No clocks inside sim/ai.' },
        { selector: "NewExpression[callee.name='Map']", message: 'Avoid Map in sim/ai state; iteration order accidents break determinism. Use arrays indexed by id.' },
        { selector: "NewExpression[callee.name='Set']", message: 'Avoid Set in sim/ai state; use arrays or bitfields.' },
      ],
      'no-restricted-imports': ['error', { patterns: [
        { group: ['three', 'three/*'], message: 'No Three.js inside sim/ai.' },
        { group: ['peerjs'], message: 'No network inside sim/ai.' },
        { group: ['**/render/**', '**/ui/**', '**/input/**', '**/audio/**', '**/net/**', '**/platform/**', '**/app/**', '**/modes/**'], message: 'sim/ai may import only contracts, sim, ai and data.' },
      ] }],
    },
  },
);
