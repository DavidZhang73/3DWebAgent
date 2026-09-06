import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const localEdge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
export default defineConfig({
  testDir: './tests/ui',
  timeout: 30000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5182',
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      executablePath: process.env.BROWSER_PATH || (existsSync(localEdge) ? localEdge : undefined),
    },
  },
  webServer: {
    command: 'pnpm exec vite preview --host 127.0.0.1 --port 5182 --strictPort',
    url: 'http://127.0.0.1:5182',
    reuseExistingServer: false,
  },
});
