# supabase-worker-previews

## 0.3.0

### Minor Changes

- b490acd: Security hardening from an audit:

  - Previews are matched by exact name only, so a branch that shares a URL slug (`feat-x`, `Feat/X`) can no longer change or delete another PR's Preview.
  - `shared` checks the branch record before writing to it, and `up` refuses the trunk and persistent branches.
  - `prune` refuses a repo that has no branch named after the trunk.
  - wrangler runs with `npx --no-install` and is never downloaded on the fly. The action pins its fallback version to the release and no longer sets `npm_config_yes`; the templates install with `npm ci`, pin `actions/checkout` and `setup-node` by SHA and set `persist-credentials: false`.
  - The PR status comment is only ever updated when a bot wrote it, and branch names and errors can no longer break its formatting.
  - Dotenv files set only the token variables, never `NODE_OPTIONS` or anything else.
  - `init` never writes through a symlink.
  - `SUPABASE_OVERRIDE` applies only its four values and must be a JSON object.
  - The injected script reuses the page's CSP nonce, and the new `script: "json"` option emits a non-executing block for a strict CSP; `globalName` must be an identifier.

## 0.2.0

### Minor Changes

- fed2f3c: The CLI is only `supabase-worker-previews` now: the `swp` command is gone, because `npx swp` on a machine without this package runs an unrelated npm package named `swp` that deletes dependency and build folders. `swp.config.json` is now `supabase-worker-previews.json`, `.env.swp` is now `.env.supabase-worker-previews` and `SWP_DEBUG` is now `SUPABASE_WORKER_PREVIEWS_DEBUG`; the old names still work, with a warning, and `doctor` says what to rename.

## 0.1.1

### Patch Changes

- aebe348: The CLI also installs as `supabase-worker-previews`, and the docs, templates and `swp init` now use `npx supabase-worker-previews`. On a machine without this package, `npx swp` resolves to an unrelated npm package named `swp` that deletes dependency and build folders.

## 0.1.0

Initial release: the `swp` CLI (`init`, `doctor`, `shared`, `up`, `check`, `down`, `pr`) and the `withSupabasePreviews()` Worker runtime.
