# supabase-worker-previews

## 0.1.1

### Patch Changes

- aebe348: The CLI also installs as `supabase-worker-previews`, and the docs, templates and `swp init` now use `npx supabase-worker-previews`. On a machine without this package, `npx swp` resolves to an unrelated npm package named `swp` that deletes dependency and build folders.

## 0.1.0

Initial release: the `swp` CLI (`init`, `doctor`, `shared`, `up`, `check`, `down`, `pr`) and the `withSupabasePreviews()` Worker runtime.
