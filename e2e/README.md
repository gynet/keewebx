# E2E Tests

End-to-end tests using [Playwright](https://playwright.dev/).

## Run

```bash
bun run test:e2e          # Run all E2E tests (headless)
bunx playwright test --ui # Interactive UI mode
bunx playwright test --list  # List all discovered tests
```

## Structure

```
e2e/
  core/           Core web app tests (baseURL: localhost:8085)
  extension/      Browser extension tests (needs built extension)
  integration/    Cross-component tests (core + extension)
  fixtures/       HTML test pages for autofill testing
  screenshots/    Failure screenshots (gitignored)
  TEST_PLAN.md    Full test plan with scenario IDs
```

## Add new tests

Create `*.spec.ts` files under `e2e/`. Group by component: `e2e/core/`, `e2e/extension/`, etc.

Tests use `baseURL: http://localhost:8085`. Playwright builds Classic and the new interface, then starts `e2e/serve-app.ts` to serve the production assets. Keep this port free so each run tests its own build. Browsers run headlessly and the HTML report never opens automatically.


### Production offline shell

Use Node 22 or newer for the installed build tools. These tests use fresh,
synthetic browser profiles and generated KDBX files; they do not access a live site.

```sh
bun run build
bunx playwright test -c e2e/offline/playwright.config.ts
```

Both Chromium and Firefox cover a New-only first visit, a browser-process restart
with browser networking disabled and the origin refusing connections, root and
nested deployment scopes, Classic offline boot, explicit updates, encrypted vault
retention, unsaved New entry drafts, and rollback after a failed asset fetch.
`KEEWEBX_CHROMIUM_EXECUTABLE` and `KEEWEBX_FIREFOX_EXECUTABLE` can select existing
Playwright browser binaries. No clipboard permissions are requested.

For preview isolation, build both interfaces into a separate namespaced output:

```sh
KEEWEBX_STORAGE_NAMESPACE=offline-preview bun run --cwd modules/ui-classic build --output-path "$PWD/.cache/offline/preview"
KEEWEBX_STORAGE_NAMESPACE=offline-preview bun run --cwd modules/ui build --output-path "$PWD/.cache/offline/preview"
bunx playwright test -c e2e/offline/preview.config.ts
```

The preview test checks absent worker/manifest artifacts, no registration by either
interface, independent vault records, and exclusion from the normal offline cache.
`KEEWEBX_PREVIEW_DIST` optionally overrides the preview build directory.

Cache unit tests run with:

```sh
bun test modules/ui-classic/tests/sw/shell-cache.test.ts
```
