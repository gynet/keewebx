import { defineConfig, devices } from '@playwright/test';

// Local projects need the dev server; the `live` project hits a remote
// URL (gh-pages) and must NOT launch the local server. Playwright doesn't
// let individual projects opt out of a top-level webServer, so we gate
// the webServer config on whether the invocation is targeting only the
// `live` project. Detection: CLI arg `--project=live` (used by the
// `test:e2e:live` script and the verify-live CI job).
const isLiveOnly = process.argv.some((a) => a === '--project=live' || a === '--project=live,');

const LIVE_URL = process.env.KEEWEBX_LIVE_URL || 'https://keewebx.app/';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  reporter: [['html', { open: 'on-failure' }]],

  use: {
    baseURL: 'http://localhost:8085',
    screenshot: 'on',
    trace: 'on-first-retry',
    video: 'on',
  },

  projects: [
    {
      name: 'chromium',
      testDir: './e2e/core',
      use: {
        ...devices['Desktop Chrome'],
        // Chromium-only: grant clipboard read/write so
        // `navigator.clipboard.*` works without prompts. Putting this
        // here (not in top-level `use`) avoids Firefox's
        // `Unknown permission: clipboard-read` failure on context
        // creation. Clipboard tests gate themselves to chromium too,
        // see e2e/core/clipboard.spec.ts.
        permissions: ['clipboard-read', 'clipboard-write'],
      },
    },
    {
      name: 'firefox',
      testDir: './e2e/core',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      // Live demo smoke — targets the deployed gh-pages URL directly, no
      // webServer, no baseURL override. Invoked by CI verify-live job and
      // by `bun run test:e2e:live`. See e2e/live/smoke-live.spec.ts.
      name: 'live',
      testDir: './e2e/live',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: LIVE_URL,
      },
    },
    {
      // Extension E2E — loads the built KeeWebX Connect extension as
      // unpacked and drives it via chrome.* APIs from the test. Needs
      // `cd packages/extension && bun run build-chrome` first. Does NOT
      // use the top-level webServer because the tests launch their own
      // persistent Chromium context with --load-extension, which is
      // incompatible with the headless webServer-driven projects above.
      // See e2e/extension/*.spec.ts.
      name: 'extension',
      testDir: './e2e/extension',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],

  // Only launch the local dev server when running the local-target
  // projects. `bun run test:e2e:live` / CI `verify-live` use
  // `--project=live` and skip this entirely — they hit LIVE_URL instead.
  ...(isLiveOnly
    ? {}
    : {
        webServer: {
          command: 'bun run --filter @keewebx/core dev',
          url: 'http://localhost:8085',
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
        },
      }),
});
