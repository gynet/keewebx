# Compatible extension command acceptance

This installs a disposable Manifest V3 client in Chromium and talks to the compiled New UI through the production tab transport and content bridge. It performs the signed identity handshake and authenticates encrypted responses independently. Tests use visible app consent/session controls and independently decrypt downloaded KDBX files.

```sh
bun install --frozen-lockfile
KEEWEBX_NEW_EXTENSION=1 bun run build
bun e2e/extension-command-client/build.ts
KEEWEBX_E2E_PORT=8127 bunx playwright test -c e2e/extension-command-client/playwright.config.ts
```

`KW_E2E_COMMAND_CLIENT_DIR` overrides both the fixture build destination and the installed package path. Playwright's `--output` option redirects traces, screenshots and failure diagnostics. The suite creates temporary browser profiles and deletes them after each test. All vault credentials and entries are synthetic.

The tests cover OTP, chosen protected fields, Save/update/history, group tree/create, counters, closed recent vault revocation, cancellation and lock/revocation during a pending OTP operation. The OTP guard delays completion of the real browser HMAC operation; it does not substitute app models or protocol decisions. The expected OTP is independently computed with Node crypto.

This is compatible-client protocol acceptance. It does not add a bundled Connect capture workflow or exercise Embedded Full. Chromium supports unpacked extension loading through Playwright; Firefox session/dialog controls are covered separately by `e2e/new-protocol-ui`.
