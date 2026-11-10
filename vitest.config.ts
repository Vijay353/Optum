import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
  },
});
