import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // apps/web non ha una cartella src: i suoi moduli condivisi stanno in lib/,
    // e un test li' dentro veniva semplicemente ignorato — cioe' verde senza
    // essere mai stato eseguito.
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/web/lib/**/*.test.ts',
    ],
    environment: 'node',
  },
});
