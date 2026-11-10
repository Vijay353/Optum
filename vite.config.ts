import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = process.env.EB_PORT ?? "8787";

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
});
