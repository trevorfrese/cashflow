import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.int.test.ts'],
          // The eval suites play whole synthetic portfolios forward. They take a second or two
          // locally and several times that on a shared CI runner, so 5 seconds is too tight.
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts'],
          setupFiles: ['src/test/setup-env.ts'],
          globalSetup: ['src/test/global-setup.ts'],
          // Integration tests share one database, so run files one at a time.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
