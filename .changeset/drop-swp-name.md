---
"supabase-worker-previews": minor
---

The CLI is only `supabase-worker-previews` now: the `swp` command is gone, because `npx swp` on a machine without this package runs an unrelated npm package named `swp` that deletes dependency and build folders. `swp.config.json` is now `supabase-worker-previews.json`, `.env.swp` is now `.env.supabase-worker-previews` and `SWP_DEBUG` is now `SUPABASE_WORKER_PREVIEWS_DEBUG`; the old names still work, with a warning, and `doctor` says what to rename.
