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
        // Inline root index.js and db service so vi.mock('pg') intercepts their require() calls
        inline: [/\/backend\/index\.js/, /\/src\/services\/db\.service\.js/],
      },
    },
  },
});
