import type { ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = {
  test: {
    coverage: {
      exclude: ['src/index.ts', 'src/providers/openai/index.ts', 'src/testing/index.ts'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        branches: 90,
        functions: 95,
        lines: 95,
        statements: 95,
      },
    },
    include: ['test/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
  },
};

export default config;
