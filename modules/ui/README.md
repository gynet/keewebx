# New interface

The Preact interface lives in `src/`, separately from `../ui-classic`.
Both interfaces use the shared models, storage and synchronization in
`../vault` and KDBX implementation in `../db`. Shared visual components and
icons live in `../ui-kit`. This package must not import Classic code or styles.

Run `bun run build` at the repository root. Both interfaces are emitted into
the root `dist/`, with this interface at `next.html`. The root build runs
`bun run check:boundaries` to enforce package dependency directions.
