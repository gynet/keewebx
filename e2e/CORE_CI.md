# New and Classic core CI

The `e2e-new-interface-core` and `e2e-classic-interface-core` jobs each run Chromium
and Firefox. They build both interfaces once per job with `KEEWEBX_NEW_EXTENSION=1`,
then serve those files without rebuilding. All `core/next-*.spec.ts` cases belong
to New; every other core spec, including shared offline coverage, runs in the
Classic projects. New core specs are included
by naming convention, without maintaining an allowlist.

After preparing the build and installing the browsers, run any of the four
projects (`new-chromium`, `new-firefox`, `classic-chromium`, `classic-firefox`):

```bash
bunx playwright test --config e2e/core-ci.playwright.config.ts --project=new-chromium
```

Omit `--project` to run all four. The static server owns port 8112 (override with
`KEEWEBX_E2E_PORT`); an occupied port fails rather than reusing an unknown server.
The runner is headless, uses one worker and zero retries, and never opens a report.
CI uploads HTML and JSON results from `playwright-report/core-ci/` plus failure
traces, videos, and screenshots from `e2e/test-results-core-ci/`, even on failure.

Firefox discovers the same tests. Individual tests explain exclusions for native
clipboard permissions, CDP touch injection, and CDP virtual authenticators; these
cases execute in Chromium. Missing build assets and unsuccessful actions must
fail, rather than becoming dynamic skips. Product regressions remain failing
until their implementation is fixed; do not add failure-based exclusions.
