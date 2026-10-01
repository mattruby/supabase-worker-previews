---
name: supabase-worker-previews
description: Branch previews for a Cloudflare Worker backed by Supabase, using the supabase-worker-previews package (`swp`). Use whenever a project deploys a Worker with Workers Builds and uses Supabase, and the task touches branch or PR previews, Worker Previews, Supabase branching, the Supabase GitHub integration, preview databases, `previews` in wrangler config, SUPABASE_OVERRIDE, or symptoms like "the preview 403s", "the preview shows production data", "the preview still serves the old database", "the PR check is red", "a deleted preview still loads".
---

# Supabase + Cloudflare Worker previews

The setup mirrors Vercel's Production/Preview split on Cloudflare:

| Environment                                                                      | Database                                                                |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Production Worker                                                                | the Supabase project itself (`supabaseProjectRef` in `swp.config.json`) |
| Worker Preview of any branch                                                     | the persistent `preview` branch of that project, which tracks the trunk |
| Worker Preview of a PR that changes `supabase/` (or has the `isolated-db` label) | its own Supabase branch, made by Supabase's GitHub integration          |

Who does what:

- **Workers Builds** builds every push. Production branch: the normal deploy. Other branches: `npx wrangler preview`.
- **Supabase GitHub integration** (automatic branching on, deploy to production **off**) migrates the `preview` branch on trunk pushes and creates, migrates, seeds and deletes a branch per schema-changing PR.
- **wrangler `previews.vars`** holds the shared Preview database's public values, committed. Every Preview deploy reads them fresh.
- **Preview base config** holds secrets only (the shared Preview database's secret key, plus app secrets).
- **`swp pr`** (GitHub Actions) gives the Preview of a PR with its own database one `SUPABASE_OVERRIDE` secret, proves which database each Preview serves, and cleans up on close.
- **`withSupabasePreviews()`** wraps the Worker: applies the override, injects the public config into HTML, and serves `/.well-known/supabase-preview` for `swp check`.

Start every investigation with `npx supabase-worker-previews doctor` (add tokens for the online checks). Never point a Preview, test or reset at the production project; `swp` refuses to touch the default branch and `check` fails any Preview that serves production.

## Facts that cost real debugging time

Read `references/gotchas.md` before changing the pipeline. The short version:

1. **Let Supabase build branches from the repo.** A branch made through the Management API on a project not linked to GitHub copies the schema _without privileges_, so every signed-in read 403s. Integration-made branches run the migration files.
2. **Default privileges must be the first migration.** Supabase branches (and newer projects) start without API-role default privileges. `swp init` writes the migration; `doctor` checks it is first.
3. **A Preview copies the base config once, when created.** Changing the base config never reaches existing Previews. That is why public database values live in `previews.vars` and a PR's own database arrives as a Preview secret.
4. **A var and a secret must never share a name**, hence the single `SUPABASE_OVERRIDE` secret instead of four.
5. **Previews inherit no bindings.** Redeclare every binding (rate limiters, KV, D1, ...) under `previews`.
6. **Branch status runs ahead of migrations.** Wait for the migration count, not `FUNCTIONS_DEPLOYED`.
7. **`config.toml` is re-applied to branches on every push**, so preview hostnames belong in `[auth] additional_redirect_urls` (`https://*-<worker>.<subdomain>.workers.dev/**`).
8. **Measure, don't assume.** A deploy that exits 0 has shipped nothing you know about until you check which database the page reads (`swp check`) and sign in with a real browser.
