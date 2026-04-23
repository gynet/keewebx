# KeeWebX E2E Test Plan

Comprehensive end-to-end test scenarios for the KeeWebX password manager.

Tests are organized by component and run via Playwright (`bun run test:e2e`).

## Test Infrastructure

| Config | Value |
|--------|-------|
| Framework | Playwright |
| Core dev server | `http://localhost:8085` |
| Browsers | Chromium, Firefox |
| Screenshots | On failure only |
| Traces | On first retry |
| Fixture pages | `e2e/fixtures/` (login-page.html, multi-field.html) |

## Core Web App (`e2e/core/`)

### Smoke (smoke.spec.ts) -- EXISTS

| # | Scenario | Status |
|---|----------|--------|
| S-1 | Page loads without JavaScript errors | Implemented |
| S-2 | No console errors on load | Implemented |

### Database Creation (database-create.spec.ts)

| # | Scenario | Priority |
|---|----------|----------|
| DC-1 | "New" button is visible on the open screen | P0 |
| DC-2 | Clicking "New" opens the password input field | P0 |
| DC-3 | Enter password and confirm to create KDBX4 database | P0 |
| DC-4 | Newly created database shows default group structure | P1 |
| DC-5 | Creating a database with a weak password shows warning | P2 |
| DC-6 | Cancel during creation returns to open screen | P1 |

### Entry Management (entry-management.spec.ts)

| # | Scenario | Priority |
|---|----------|----------|
| EM-1 | Add a new entry via the "+" button | P0 |
| EM-2 | Fill Title, Username, Password, URL, Notes fields | P0 |
| EM-3 | Newly created entry appears in the list | P0 |
| EM-4 | Click an entry to view its details | P0 |
| EM-5 | Edit an existing entry's title | P1 |
| EM-6 | Edit an existing entry's password | P1 |
| EM-7 | Delete an entry (move to Recycle Bin) | P0 |
| EM-8 | Copy password to clipboard via button | P0 |
| EM-9 | Copy username to clipboard via button | P1 |
| EM-10 | Generated password is applied to entry | P1 |
| EM-11 | Entry history records changes | P2 |

### Search (search.spec.ts)

| # | Scenario | Priority |
|---|----------|----------|
| SR-1 | Search field is visible when database is open | P0 |
| SR-2 | Typing in search filters entries by title | P0 |
| SR-3 | Search finds entries by username | P1 |
| SR-4 | Search finds entries by URL | P1 |
| SR-5 | Clearing search restores full list | P0 |
| SR-6 | No results state shown for unmatched query | P1 |
| SR-7 | Ctrl+F / Cmd+F focuses the search field | P1 |
| SR-8 | Advanced search options toggle works | P2 |
| SR-9 | Case-sensitive search option works | P2 |
| SR-10 | Regex search option works | P2 |

### Settings (settings.spec.ts)

| # | Scenario | Priority |
|---|----------|----------|
| ST-1 | Settings page loads from menu | P0 |
| ST-2 | General settings tab is interactive | P1 |
| ST-3 | Shortcuts settings tab shows key bindings | P1 |
| ST-4 | About section shows version info | P2 |
| ST-5 | "Back to app" button returns to main view | P0 |
| ST-6 | Browser settings tab renders | P2 |
| ST-7 | Plugins settings tab renders | P2 |

### WebDAV Storage (webdav.spec.ts)

| # | Scenario | Priority |
|---|----------|----------|
| WD-1 | WebDAV storage option appears in "More" menu | P0 |
| WD-2 | WebDAV config form accepts URL, username, password | P0 |
| WD-3 | Invalid WebDAV URL shows error feedback | P1 |
| WD-4 | Successful WebDAV connection lists remote files | P0 |
| WD-5 | Save database to WebDAV | P1 |
| WD-6 | Open database from WebDAV | P1 |

### Database Lifecycle (database-lifecycle.spec.ts) -- EXISTS

| # | Scenario | Status |
|---|----------|--------|
| DL-1 | App loads and renders main UI | Implemented |
| DL-2 | Reopen database with correct password | Planned |
| DL-3 | Reopen database with wrong password shows error | Planned |
| DL-4 | Save database triggers download or IndexedDB persist | Planned |

### Keyboard & Accessibility

| # | Scenario | Priority |
|---|----------|----------|
| KA-1 | Ctrl+F / Cmd+F opens search | P1 |
| KA-2 | Escape closes modals / detail panels | P1 |
| KA-3 | Tab navigation through open screen | P2 |

### Responsive Layout

| # | Scenario | Priority |
|---|----------|----------|
| RL-1 | Mobile viewport renders without horizontal overflow | P1 |
| RL-2 | Menu collapses on small screens | P1 |

---

## Extension (`e2e/extension/`)

Requires loading the built extension in a Chromium browser context.

### Extension Loading

| # | Scenario | Priority |
|---|----------|----------|
| EX-1 | Extension loads in Chrome without errors | P0 |
| EX-2 | Extension popup renders (action click) | P0 |
| EX-3 | Extension options page loads | P1 |

### Connection to Web App

| # | Scenario | Priority |
|---|----------|----------|
| EC-1 | Extension detects KeeWebX tab | P0 |
| EC-2 | Extension establishes encrypted connection | P0 |
| EC-3 | Extension receives entry list from web app | P1 |

### Autofill

| # | Scenario | Priority |
|---|----------|----------|
| AF-1 | Detects login form fields (username + password) | P0 |
| AF-2 | Fills username field | P0 |
| AF-3 | Fills password field | P0 |
| AF-4 | Fills and submits form | P0 |
| AF-5 | Handles multi-field forms (email, password, confirm) | P1 |
| AF-6 | TOTP code retrieval and insertion | P1 |

### Context Menu & Shortcuts

| # | Scenario | Priority |
|---|----------|----------|
| CM-1 | Context menu appears on right-click in form fields | P1 |
| CM-2 | Context menu items trigger correct fill actions | P1 |
| KS-1 | Ctrl+Shift+U triggers autofill | P1 |
| KS-2 | Individual insert commands work (username, password, OTP) | P2 |

---

## Cross-Component Integration (`e2e/integration/`)

Requires both core web app and extension loaded together.

| # | Scenario | Priority |
|---|----------|----------|
| INT-1 | Create DB in web app, extension detects entries | P0 |
| INT-2 | Add entry in web app, immediately available in extension | P0 |
| INT-3 | Autofill on test login page using entry from web app | P0 |
| INT-4 | Edit entry in web app, extension uses updated credentials | P1 |
| INT-5 | Delete entry in web app, extension no longer offers it | P1 |

---

## Test Fixtures

### `e2e/fixtures/login-page.html`

Simple HTML login form for autofill testing. Contains username + password inputs with a submit button.

### `e2e/fixtures/multi-field.html`

Complex registration form with: email, username, password, confirm password, TOTP code, and a remember-me checkbox.

---

## Running Tests

```bash
# All E2E tests
bun run test:e2e

# Core web app only
bunx playwright test e2e/core/

# Extension only (requires built extension)
bunx playwright test e2e/extension/

# Integration only
bunx playwright test e2e/integration/

# Interactive UI mode
bunx playwright test --ui

# Specific file
bunx playwright test e2e/core/search.spec.ts
```

## Blocking Dependencies

| Test Group | Blocked On |
|-----------|-----------|
| Core (all except smoke) | Core webpack build completing without errors |
| Extension | Extension build + Playwright Chrome extension fixture |
| Integration | Both core + extension builds, plus protocol handshake |

## Coverage Goals

- **Phase 1**: All P0 scenarios passing for core web app
- **Phase 2**: Extension loading + basic autofill
- **Phase 3**: Full integration suite
