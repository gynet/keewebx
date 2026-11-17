# KeeWebX 0.4.11

Superseded by 0.4.12, which restores configured synchronization in local HTML.

## Changes

- Updates found during an unlocked session wait silently for the next startup.
  The startup check remains bounded to 2.5 seconds. Manual activation is tied to
  its requested worker and is canceled if the screen becomes unsafe to reload.
  A stale ready flag without a waiting worker no longer causes a pointless reload.
- Opening local HTML through `file://` never contacts an update server or loads
  remote configuration. Synchronization and online password checks are disabled,
  including retained settings from an older session. Before the App loads, a
  second browser CSP blocks network APIs except website icons. Direct icon
  downloads and optional DuckDuckGo icon display remain available; New's local
  icon downloads bypass configured server proxies. HTTP(S) self-hosted sites
  retain their configured network features.
- Password generation keeps common controls visible. Advanced folds additional
  character sets, patterns, derivation and preset management while preserving
  their values. Mask/reveal, regenerate, copy and use-password remain available.
- Connect 0.6.12 makes the App key movable by pointer or keyboard, remembers its
  coordinates, and keeps its panel within small viewports. Website icons stay
  anchored to login fields. Connect transport/authentication is unchanged.

## Verification

- Full database, Classic and New production build and TypeScript checks passed.
- 17 isolated New UI test files and 373 Connect transport unit tests passed.
- 24 startup/update browser scenarios, 26 update unit tests and four encrypted-vault
  E2E cases passed. These include no banner while unlocked and cancellation of a
  previously requested update after unlocking.
- 11 focused generator E2E tests passed.
- 25 launcher interactions and 216 existing Connect component cases passed
  across Chromium and desktop WebKit.
- Six native browser local-file checks passed: New and Classic in Chromium,
  Firefox and desktop WebKit. No server requests occurred during startup with
  retained online-check preferences and a configured remote startup URL. A live
  HTTPS fixture received no explicit version/config/beacon probes blocked by
  CSP, and did receive the permitted website icon request.
- Actual extracted New and Classic ZIPs passed 35 startup checks across file,
  localhost, nested hosting and offline reload paths.

Native iOS acceptance is separate from desktop WebKit coverage. CI runs the
local-file policy checks and drag checks on future changes. Download a new
release separately to replace a local installation; local HTML never polls for
one.
