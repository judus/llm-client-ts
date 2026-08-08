import type { ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = {
  resolve: {
    alias: {
      '@maduser/ai-ts': new URL('./packages/ai/src/index.ts', import.meta.url).pathname,
      '@maduser/ai-ts-openai': new URL('./packages/openai/src/index.ts', import.meta.url).pathname,
      '@maduser/ai-ts-testing': new URL('./packages/testing/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    coverage: {
      exclude: ['**/dist/**', '**/index.ts'],
      include: ['packages/*/src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        branches: 90,
        functions: 95,
        lines: 95,
        statements: 95,
      },
    },
    include: ['packages/*/test/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
  },
};

export default config;
