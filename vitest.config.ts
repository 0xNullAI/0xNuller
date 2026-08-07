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
      'apps/chat',
      'apps/voice',
      'apps/mcp',
      'android/agent',

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
          include: ['packages/agent/*/src/**/*.test.ts'],
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
