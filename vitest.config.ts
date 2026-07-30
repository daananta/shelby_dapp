import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./frontend") } },
  test: { environment: "node", include: ["frontend/**/*.test.ts", "api/**/*.test.ts"] },
});
