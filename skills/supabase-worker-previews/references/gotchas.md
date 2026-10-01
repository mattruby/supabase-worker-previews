# Measured behaviour

Observed on real Cloudflare and Supabase Pro accounts in September 2026, with wrangler 4.135 to 4.145. Re-measure when something disagrees.

## Supabase branches

| Created by                                                                             | What Supabase does                                                                               | Grants                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Management API `POST /projects/{ref}/branches`, project **not** linked to GitHub       | Copies the parent's schema and migration history **without privileges**; `git_branch` is ignored | Tables get only owner privileges, functions none: signed-in reads 403 |
| GitHub integration (PR touching `supabase/`, or the API with `git_branch` once linked) | Runs the repo's migrations from that git branch, then `seed.sql`, then applies `config.toml`     | Whatever the migrations grant                                         |

- With the default-privileges migration first, an integration-made branch matched production object for object (0 ACL differences across ~190 objects).
- The first branch created on a never-branched project either relabels the project itself as that branch, or creates a real database and renames the project's branch `main`. Both were seen on different projects. `swp shared` creates a throwaway first branch so a real one is never mistaken for production.
- `GET /v1/branches/{ref}` 404s for several seconds after creation.
- Branch status reaches `FUNCTIONS_DEPLOYED` before the migrations finish. `swp` waits until `supabase_migrations.schema_migrations` holds as many rows as there are local migration files.
- Persistent branches refuse `DELETE` until patched `persistent: false`. `swp down` never deletes them.
- Branch billing is per hour of compute (roughly $10 a month for an always-on Micro branch).
- The Management API has no field for whether a project is connected to GitHub. `GET /v1/projects/{branch_ref}/actions` lists a branch's runs; a run the integration made carries `git_config: {owner, repo, ref}` and clone/pull steps. A connected branch can also have older runs with `git_config: null`, so look for any run that has it.
- The default branch's `git_branch` is an empty string, not null.
- `GET /v1/projects/{ref}/api-keys?reveal=true` returns legacy keys named `anon` and `service_role` with `type: "legacy"` (JWTs), and new keys named `default` with `type` `publishable` or `secret` (`sb_publishable_`, `sb_secret_`). Without `reveal`, the secret key comes back masked with `·`. `GET /v1/projects/{ref}/api-keys/legacy` returns `{enabled}`. New keys are not JWTs, so Edge Functions that verify JWTs reject them.
- Supabase access tokens can be scoped. A token scoped to one project lists no organizations; use an organization-scoped token for tooling.

## Cloudflare Worker Previews

- Need wrangler 4.135 or later and a `previews` block in the wrangler config.
- Workers Builds names a Preview after the raw git branch (`feat/x`); Cloudflare derives the slug (`feat-x`) and the URL `https://feat-x-<worker>.<subdomain>.workers.dev`. `swp` reads both from `GET /accounts/{id}/workers/workers/{worker}/previews` rather than guessing.
- A Preview build can fail on wrangler's first API call with Cloudflare code 10013 ("unknown error") after Workers Builds has already created the Preview record, leaving `deployed_on: null`. A rebuild with the same command succeeded.
- Some framework entries call the Worker's `fetch` without `env` (TanStack Start on Nitro), so the runtime falls back to `process.env`.
- By default a request that matches a static asset is served without running the Worker, so HTML in the assets directory gets no injected Supabase config. Set `assets.run_worker_first`.
- A Preview record can exist with `deployed_on: null`, answering 404 on every path, when its build never deployed. `swp check` reports this explicitly.
- **Base config is copied once.** A Preview copies the base config when first created and keeps that copy; redeploying does not refresh it. To refresh, delete the Preview and push again.
- `wrangler preview base-config secret bulk` merges: keys not in the payload stay.
- Writing a Preview secret creates a new deployment of that Preview.
- Previews inherit no bindings from the top-level config.
- After delete and recreate, the hostname served the old version for a few seconds.
- A Preview first created **from a laptop** (`wrangler preview` run locally) kept serving after deletion, by wrangler or the API, for 15+ minutes, while the API no longer listed it. Previews created by Workers Builds 404 within 15 seconds of deletion. Prefer pushing a branch to laptop Previews.
- Old `wrangler versions upload --preview-alias` aliases cannot be deleted and run with **production** secrets. Do not use them for previews; point a stale one at a stub version.
- Turning off the Worker's preview URLs also takes every Worker Preview down.
- Workers Builds build secrets can be set through the triggers API (list with `GET /accounts/{id}/builds/workers/{worker_tag}/triggers`, then `PATCH` the trigger's `environment_variables`). Preview builds cannot see production build secrets.
- The Workers Builds dashboard accepted only a literal `npx wrangler preview` as the Preview command, which is why `swp` matches Previews by raw branch name.
- A branch that once built as a Preview can keep a per-branch Preview trigger that outranks a later production trigger for the same branch. Delete it when promoting a branch to production.
