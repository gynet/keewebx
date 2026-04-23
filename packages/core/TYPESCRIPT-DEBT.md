# TypeScript type debt ratchet

## Current baseline
See [`.typescript-baseline`](./.typescript-baseline). As of 2026-04-09: **368 errors**.

## Why this file exists
`packages/core/webpack.config.js:126` sets `transpileOnly: true` on
ts-loader. This skips the type checker during webpack build for
performance, but it also means every bug that would have been caught by
TypeScript ships to production instead. The 2026-04-09 warroom landed
eight separate fixes, most of which would have been blocked by a real
`tsc --noEmit` run:

- `settings-store.ts` stub that returned `Promise<void>` while callers
  expected `Promise<unknown | null>` (type mismatch, silently ignored)
- `shortcuts.ts` partial stub missing `shiftShortcutSymbol` (caller
  `select-entry-view.ts:156` would have flagged a missing method)
- `ConnectionWeb` conditional rendering on `model.useWebApp` that was
  never defined on the model (undefined property access)
- Unused defensive `new Uint8Array(nonceBytes)` wrappers that
  destroyed mutation-aliasing semantics (would have required a bigger
  TS change to catch, but `tsc` would at least have flagged the
  resulting argument type mismatch)

## How the ratchet works
CI runs `tsc --noEmit` on `packages/core` and counts `error TS` lines.
It compares against the number in `.typescript-baseline`:

- **count > baseline** → CI fails with "TypeScript type debt increased".
  The PR introduced new type errors. Either fix them or justify raising
  the baseline (rarely acceptable — see below).
- **count == baseline** → CI passes silently.
- **count < baseline** → CI passes with a `::notice::` reminder to
  update `.typescript-baseline` to the new lower number in the same PR.
  Once updated, the ratchet locks in the improvement.

## When to raise the baseline
Almost never. Valid reasons:
- Adopting a stricter TS version (e.g., 5.9 → 6.0) that surfaces
  pre-existing errors that were latent under the older compiler.
- A justified type-system improvement (e.g., narrowing `Collection`
  generics) that surfaces many call sites at once AND the author
  commits to fixing them in a follow-up.

In both cases, document the reason in the PR that raises the baseline,
and open a tracking issue for the rollback.

## How to reduce the baseline
Any PR. Pick a file, fix its TS errors, rerun `bunx tsc --noEmit` to
get the new count, update `.typescript-baseline`. The CI notice at
PR time will remind you if you forget.

Biggest hot spots (as of 2026-04-09):

| File | Errors | Nature |
|---|---|---|
| `models/app-model.ts` | 181 | `Collection<T>` methods return `unknown`; callbacks have implicit any. Needs `Collection<T>` generic refactor. |
| `util/data/otp.ts` | 39 | HMAC-based OTP primitives; ArrayBuffer/Uint8Array type churn. |
| `models/file-model.ts` | 26 | Model state bag typed as `{}`. |
| `models/entry-model.ts` | 19 | Same pattern as file-model. |
| `models/menu/menu-model.ts` | 13 | Menu tree traversal with `any`. |

## End state
When `.typescript-baseline` hits 0:
1. Delete this file and `.typescript-baseline`
2. Remove `transpileOnly: true` from `packages/core/webpack.config.js:126`
3. Delete the `typecheck` job from `.github/workflows/ci.yml` (webpack
   now enforces type checks on every build)
4. Celebrate
