import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    // jsdom + the jest-dom setup so component tests (*.test.tsx) run. This file
    // shadows the `test` block in vite.config.ts, so anything a component test
    // needs has to be declared HERE — an earlier node-only/`*.test.ts` config
    // silently skipped every .tsx test in the tree.
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
