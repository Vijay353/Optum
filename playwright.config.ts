import { defineConfig, devices } from "@playwright/test";

/**
 * Browser E2E against the production build + a fresh database.
 * Locally: `npx playwright install chromium` once, then `npm run test:e2e`.
 * In restricted sandboxes, point EB_CHROMIUM_PATH at any Chromium binary.
 */
const port = 8799;
export const GATE_PORT = 8798;
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...devices["Desktop Chrome"],
    launchOptions: process.env.EB_CHROMIUM_PATH
      ? { executablePath: process.env.EB_CHROMIUM_PATH, args: (process.env.EB_CHROMIUM_ARGS ?? "--no-sandbox --disable-gpu").split(" ") }
      : {},
  },
  webServer: [
    {
      command: `npx vite build && npx cross-env NODE_ENV=production NODE_OPTIONS=--disable-warning=ExperimentalWarning EB_PORT=${port} EB_DB_PATH=data/runtime/e2e.sqlite EB_LOG_SILENT=1 tsx server/index.ts`,
      url: `http://127.0.0.1:${port}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // CH-20/21: a second server with the access gate on and a fake analytics id (requests to clarity.ms are intercepted in the test). Test-only PIN and secret, not real secrets.
      command: `node -e "const f=require('fs'),t=Date.now();for(const s of ['','-wal','-shm'])f.rmSync('data/runtime/e2e-gate.sqlite'+s,{force:true});(function w(){if(f.existsSync('dist/index.html'))process.exit(0);if(Date.now()-t>90000)process.exit(1);setTimeout(w,250)})()" && npx cross-env NODE_ENV=production NODE_OPTIONS=--disable-warning=ExperimentalWarning EB_PORT=${GATE_PORT} EB_DB_PATH=data/runtime/e2e-gate.sqlite EB_LOG_SILENT=1 EB_ACCESS_GATE=on EB_CLARITY_PROJECT_ID=ebtest01 EB_ANALYTICS_ALLOW_LOCAL=true EB_ACCESS_PIN=2468 EB_SESSION_SECRET=e2e-test-only-session-secret-0123456789abcdef tsx server/index.ts`,
      url: `http://127.0.0.1:${GATE_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 90_000,
    },
  ],
});
