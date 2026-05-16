import path from "node:path";
import { defineConfig } from "vitest/config";

const root = __dirname;

export default defineConfig({
  test: {
    environment: "node",
    globals: true
  },
  resolve: {
    alias: {
      "@market-desk/shared": path.resolve(root, "packages/shared/src/index.ts"),
      "@market-desk/data-providers": path.resolve(root, "packages/data-providers/src/index.ts"),
      "@market-desk/core": path.resolve(root, "packages/core/src/index.ts"),
      "@market-desk/analysis-engine": path.resolve(root, "packages/analysis-engine/src/index.ts"),
      "@market-desk/compliance": path.resolve(root, "packages/compliance/src/index.ts"),
      "@market-desk/telegram": path.resolve(root, "packages/telegram/src/index.ts"),
      "@market-desk/db": path.resolve(root, "packages/db/src/index.ts")
    }
  }
});
