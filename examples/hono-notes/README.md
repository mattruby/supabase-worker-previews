# Hono notes: a complete `supabase-worker-previews` setup

A minimal [Hono](https://hono.dev) Worker that lists notes from Supabase, wired for Supabase Worker Previews. Every file `supabase-worker-previews` cares about is here, so you can read the whole setup in a few minutes or copy it as the start of a new repo.

| File                                                             | What it shows                                                                           |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`src/index.ts`](src/index.ts)                                   | The Hono app wrapped in `withSupabasePreviews()`, and a server route that reads `c.env` |
| [`src/page.ts`](src/page.ts)                                     | A no-build HTML page that reads `readPublicConfig()` and lists notes with supabase-js   |
| [`wrangler.jsonc`](wrangler.jsonc)                               | Production `vars` at the top level, the shared Preview database in `previews.vars`      |
| [`supabase-worker-previews.json`](supabase-worker-previews.json) | The production project ref and the trunk                                                |
| [`supabase/migrations/`](supabase/migrations)                    | The grants migration first, then the `notes` table                                      |
| [`supabase/seed.sql`](supabase/seed.sql)                         | Sample rows for every branch database                                                   |
| [`supabase/config.toml`](supabase/config.toml)                   | Auth redirects that allow every Preview hostname                                        |
| [`.github/workflows/`](.github/workflows)                        | The PR workflow, using the published GitHub Action                                      |
| [`.dev.vars.example`](.dev.vars.example)                         | Local values for `wrangler dev`                                                         |

## How the pieces fit

**The Worker** ([`src/index.ts`](src/index.ts)) is an ordinary Hono app. The only addition is the last line:

```ts
export default withSupabasePreviews({ fetch: app.fetch });
```

That wrapper does three things on every request: it applies a PR's `SUPABASE_OVERRIDE` secret to `env` when there is one, it injects the public Supabase URL and key into every HTML response, and it answers `/.well-known/supabase-preview` so `supabase-worker-previews check` can ask which database this Preview serves.

**Server code** reads Supabase settings from `c.env`, which Hono fills from the wrapped `env`. On a PR with its own database, `c.env.SUPABASE_URL` is that database. (Code that imports `env` from `cloudflare:workers` would see the raw values instead; this example never does.)

**The page** ([`src/page.ts`](src/page.ts)) has no Supabase values of its own and no build step. It calls `readPublicConfig()` to get what the Worker injected and creates a supabase-js client from it. The same page, from the same build, talks to production, the shared Preview database or a PR's own database, depending only on which Worker served it.

**The database** has two migrations. The [grants migration](supabase/migrations/20260901000000_api_default_privileges.sql) comes first, because Supabase branch databases start without default privileges for the API roles and every signed-in read would 403 without it. The [`notes` migration](supabase/migrations/20260901000100_notes.sql) creates a table with Row Level Security on and one policy that lets anyone read.

**`wrangler.jsonc`** keeps production values at the top level and the shared Preview database under `previews.vars`. Previews inherit no `vars` and no bindings from the top level, so if you add a KV namespace or D1 database, redeclare it under `previews` too.

## Try it locally

```bash
npm install
npx supabase start                  # a local Supabase stack, with the migrations and seed applied
cp .dev.vars.example .dev.vars      # then paste the publishable (anon) key from `npx supabase status`
npm run dev
```

Open <http://localhost:8787>. The page shows the local database URL and the two seeded notes. `.dev.vars` overrides the production `vars` in `wrangler dev`, so local development never touches production. `curl http://localhost:8787/.well-known/supabase-preview` shows the identity route.

## Use it as a real project

This folder is laid out as the root of a repo. To run it for real, copy it into a new GitHub repository and follow the [quickstart](../../docs/quickstart.md) from step 2. In short:

1. Replace `"file:../.."` in `package.json` with the published version (`"supabase-worker-previews": "^0.1.0"`) and run `npm install`.
2. Put your production project ref in `supabase-worker-previews.json`, and the production URL, publishable key and ref in the top-level `vars` of `wrangler.jsonc`.
3. Connect the Supabase GitHub integration (automatic branching on, deploy to production off), and put your `workers.dev` subdomain in `supabase/config.toml`.
4. Run `npx supabase-worker-previews shared` and paste what it prints into `previews.vars`.
5. In Workers Builds, turn on non-production branch builds with the deploy command `npx wrangler preview`.
6. Add the `SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` Actions secrets ([tokens](../../docs/tokens.md)).
7. `npx supabase-worker-previews doctor`, then open a PR.

A PR that only changes `src/` gets a Preview on the shared Preview database. A PR that changes anything under `supabase/` (try adding a column to `notes`) gets its own database, migrated and seeded from the PR, and the comment on the PR says which one it is serving.

## Typecheck

From the repository root:

```bash
npm install                          # builds dist/, which this example links to
cd examples/hono-notes
npm install
npm run typecheck
```
