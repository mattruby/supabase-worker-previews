# supabase-worker-previews

## 0.2.0

### Minor Changes

- fed2f3c: The CLI is only `supabase-worker-previews` now: the `swp` command is gone, because `npx swp` on a machine without this package runs an unrelated npm package named `swp` that deletes dependency and build folders. `swp.config.json` is now `supabase-worker-previews.json`, `.env.swp` is now `.env.supabase-worker-previews` and `SWP_DEBUG` is now `SUPABASE_WORKER_PREVIEWS_DEBUG`; the old names still work, with a warning, and `doctor` says what to rename.

## 0.1.1

### Patch Changes

- aebe348: The CLI also installs as `supabase-worker-previews`, and the docs, templates and `swp init` now use `npx supabase-worker-previews`. On a machine without this package, `npx swp` resolves to an unrelated npm package named `swp` that deletes dependency and build folders.

## 0.1.0

Initial release: the `swp` CLI (`init`, `doctor`, `shared`, `up`, `check`, `down`, `pr`) and the `withSupabasePreviews()` Worker runtime.
