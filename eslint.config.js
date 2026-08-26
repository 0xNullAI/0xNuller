import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

/**
 * 全仓单一 eslint 配置。
 *
 * 合并前 Agent / Chat / Voice / Wiki 各有一份，规则互相漂移（Chat 的 lint 甚至被
 * `|| true` 关掉、MCP 根本没有 lint）。这里以 DG-Agent 那份最完整的为基准，
 * 适配新目录结构后作为唯一真源——不再保留 app 级配置，避免重新长出漂移。
 */

const tsRules = {
  '@typescript-eslint/consistent-type-imports': [
    'error',
    {
      prefer: 'type-imports',
      fixStyle: 'separate-type-imports',
    },
  ],
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
    },
  ],
};

const unusedVarsJs = [
  'error',
  {
    argsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/src-tauri/target/**',
      '**/src-tauri/gen/**',
      '**/.astro/**',
      '**/.wrangler/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // 浏览器侧源码：packages/{kit,agent}/*/src、各 app 的 src、安卓壳的 src
  {
    files: [
      'packages/*/*/src/**/*.ts',
      'apps/*/src/**/*.{ts,tsx}',
      'android/*/src/**/*.{ts,tsx}',
      'test/**/*.ts',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: tsRules,
  },

  // React 组件
  {
    files: ['apps/*/src/**/*.tsx', 'android/*/src/**/*.tsx'],
    plugins: {
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      // 只保留 react-hooks。原 DG-Agent 配置额外加载了 eslint-plugin-react，但它引用的
      // 两条规则（react/jsx-uses-react、react/react-in-jsx-scope）都是 'off'——插件纯粹
      // 为了关掉自己的规则而存在，且 React 19 的新 JSX 转换下这两条本就无意义。
      // 该插件 peer 上限是 eslint 9，与本仓统一的 eslint 10 冲突，故直接移除。
      ...reactHooksPlugin.configs.recommended.rules,
    },
  },

  // Cloudflare Worker 侧源码（Chat 的 RoomDO/LobbyDO、Voice 的 TrialSession、Market 的 API）
  {
    files: ['apps/*/worker/**/*.ts', 'apps/*/src/worker/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.serviceworker, ...globals.browser },
    },
    rules: tsRules,
  },

  // 纯 JS 的 Worker 中继（llm-proxy 免费 provider / speech-proxy）
  {
    files: ['workers/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.serviceworker,
        WebSocketPair: 'readonly',
      },
    },
    rules: { 'no-unused-vars': unusedVarsJs },
  },

  // Node 侧脚本（如 apps/voice/scripts/gen-trial-key.mjs）
  {
    files: ['apps/*/scripts/**/*.{ts,js,mjs}', 'scripts/**/*.{ts,js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: { ...tsRules, 'no-unused-vars': unusedVarsJs },
  },

  // 构建配置跑在 node 上
  {
    files: [
      '*.config.{ts,js,mjs}',
      'apps/*/*.config.{ts,js,mjs}',
      'android/*/*.config.{ts,js,mjs}',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: tsRules,
  },

  eslintConfigPrettier,
);
