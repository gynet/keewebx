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
