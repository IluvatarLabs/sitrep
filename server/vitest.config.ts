import { defineConfig } from 'vitest/config';

// testSetup.ts keeps supertest's servers on loopback: on macOS a server another process bound to 127.0.0.1 on the same port can
// otherwise answer a test's request.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/testSetup.ts'],
  },
});
