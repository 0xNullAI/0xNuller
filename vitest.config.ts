/// <reference types="node" />

import { defineConfig } from 'vitest/config';

/**
 * 全仓单一 vitest 进程。
 *
 * 合并前 DG-Kit 与 DG-Agent 各有一份根级配置，其余仓的配置在各自 app 目录下。
 * 这里把两者合成一份：自带 vitest.config.ts 的 workspace 直接作为 project 引入
 * （它们各自定义了 jsdom / @ 别名 / include 范围），没有独立配置的包按来源分两组。
 */
export default defineConfig({
  test: {
    projects: [
      // 自带配置的 workspace
      'apps/agent',
      'apps/web',
      'apps/chat',
      'apps/voice',
      'apps/mcp',
      'apps/playground',
      'workers/auth',
      'android/app',

      // @dg-kit/*：沿用 DG-Kit 原根配置的 node 环境与 include 范围
      {
        test: {
          name: 'kit',
          environment: 'node',
          include: ['packages/kit/**/*.{test,spec}.ts'],
        },
      },

      // @dg-agent/*：沿用 DG-Agent 原根配置的 include 规则（环境默认 node）
      {
        test: {
          name: 'agent-packages',
          // Node 26's built-in localStorage shadows jsdom's; the shim is a
          // no-op where the real one works. Without it, any test in this
          // project that reaches the shared browser stores dies on
          // `localStorage is undefined`.
          setupFiles: ['./test/setup/jsdom-gaps.ts'],
          include: ['packages/agent/*/src/**/*.test.{ts,tsx}'],
        },
      },

      // @0xnullai/*：平台层共享包。漏了这一条的失败形态是「测试静默少跑」——
      // 数量对不上但不会红，所以这里显式列出。
      {
        test: {
          name: 'platform',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./test/setup/jsdom-gaps.ts'],
          include: ['packages/platform/*/src/**/*.test.{ts,tsx}'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/*/src/**/*.ts'],
      exclude: ['packages/*/*/src/**/*.{test,spec}.ts'],
    },
  },
});
