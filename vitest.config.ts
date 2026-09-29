import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the sources of the workspace packages, no build needed.
    alias: {
      "@atm/shared": source("./packages/shared/src/index.ts"),
      "@atm/mocks": source("./packages/mocks/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
