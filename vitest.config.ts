import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/core/**/*.ts', 'src/node/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        'src/**/index.ts',
        // Pure-interface files: no runtime code, so coverage is always 0%.
        'src/core/types.ts',
        'src/core/llm/client.ts',
        'src/core/memory/store.ts',
        'src/core/session/store.ts',
        'src/core/telemetry/sink.ts',
      ],
    },
  },
});
