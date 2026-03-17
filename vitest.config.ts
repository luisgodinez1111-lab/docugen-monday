import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,js}'],
      exclude: ['src/**/__tests__/**', 'src/queues/**', 'dist/**'],
    },
    // Transform CJS source modules so vi.mock() properly intercepts require()
    server: {
      deps: {
        interopDefault: true,
        // Do not inline axios — nock intercepts at the http module level
        // inline: [],
      },
    },
  },
});
