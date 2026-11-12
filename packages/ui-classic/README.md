# Classic interface

The original KeeWebX interface lives here, alongside the new interface in
`../ui`. Classic remains the default and the fallback interface.

- `app/scripts/`: Classic views, presenters, browser integration and UI adapters.
- `app/templates/` and `app/styles/`: Classic templates and themes.
- `app/sw/`: service worker for the existing application shell.
- `app/icons/` and `graphics/`: application branding and Classic icon assets.
- `tests/`: Classic and shared-service regression tests.

Vault models, encryption, persistence and synchronization live in `../vault`
and `../db`. Both interfaces share those implementations. Do not import the
new interface from Classic; reusable presentation helpers belong in `../ui-kit`.

Run `bun run build` at the repository root to build both interfaces into
`dist/`. `index.html` is Classic; `next.html` is the new interface.
