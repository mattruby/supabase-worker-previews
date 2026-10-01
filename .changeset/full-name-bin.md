---
"supabase-worker-previews": patch
---

The CLI also installs as `supabase-worker-previews`, and the docs, templates and `swp init` now use `npx supabase-worker-previews`. On a machine without this package, `npx swp` resolves to an unrelated npm package named `swp` that deletes dependency and build folders.
