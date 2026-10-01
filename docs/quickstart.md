# Quickstart

From an existing Worker and Supabase project to the first PR whose Preview runs on the right database. Allow about ten minutes of your time plus Supabase's branch creation time.

## Before you start

You need:

- A Worker whose production deploys come from [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) connected to a GitHub repo.
- wrangler **4.135.0 or later** in the project's `devDependencies`. Earlier versions have no `wrangler preview` ([changelog](https://developers.cloudflare.com/changelog/post/2026-09-22-worker-previews/)).
- A `wrangler.jsonc` (or `wrangler.json`) with a `name`. `wrangler.toml` works for the commands, but `doctor` cannot check its `previews` block.
- A Supabase project on a plan that includes branching. Branching is not on the Free plan ([pricing](https://supabase.com/pricing)); branch compute is billed per hour.
- Your migrations in `supabase/migrations/` (the layout `supabase init` creates), committed to the repo.
- Node 20 or later.

<!-- TODO(wrangler-toml): update the wrangler.toml line once TOML support merges. -->

## 1. Install and scaffold

```bash
npm install --save-dev supabase-worker-previews
npx swp init --project-ref <production project ref>
```

The project ref is the subdomain of your project URL (`https://<ref>.supabase.co`). If the repo is linked with `supabase link`, `init` reads it from `supabase/.temp/project-ref` and you can omit the flag. `--trunk <branch>` overrides the trunk, which defaults to `origin/HEAD`, else `main`.

Expected output, in a repo that already has migrations:

```
+ swp.config.json
+ supabase/migrations/20260913235959_api_default_privileges.sql
  It is dated before your existing migrations. Production has not run it: apply it with
  `supabase db push --include-all`, or run the SQL once and `supabase migration repair --status applied 20260913235959`.
+ .github/workflows/supabase-previews.yml

Then, by hand:
  1. Supabase dashboard, project settings, Integrations, GitHub: connect the repo,
  ...
```

`init` never overwrites. A file that already exists prints `- <file> exists, left alone`.

**Apply the grants migration to production** as the message says. It is dated one second before your first migration so that branch databases run it before any table exists ([why](../skills/supabase-worker-previews/references/gotchas.md#supabase-branches)). Production already has its tables, so you either push it with `--include-all` or run the SQL once and mark it applied. If your first migration already grants default privileges to `anon`/`authenticated`, `init` says so and writes nothing.

Commit the three files.

## 2. Connect the Supabase GitHub integration

In the Supabase dashboard: **Project Settings, Integrations, GitHub Integration**.

| Setting               | Value                                                                             |
| --------------------- | --------------------------------------------------------------------------------- |
| Repository            | your repo                                                                         |
| Supabase directory    | the folder that holds `config.toml` (`supabase` unless you changed `supabaseDir`) |
| Automatic branching   | **on**                                                                            |
| Supabase changes only | **on**, so only PRs that touch the Supabase directory get a database              |
| Deploy to production  | **off**: your trunk deploy owns production migrations                             |

Supabase documents these options in [Branching via GitHub](https://supabase.com/docs/guides/deployment/branching/github-integration).

Do this **before** `swp shared`. A branch created through the API on a project that is not linked to GitHub copies the schema without privileges, and every signed-in read 403s ([measured](../skills/supabase-worker-previews/references/gotchas.md#supabase-branches)).

Then, in `supabase/config.toml`, allow your Preview hostnames as auth redirects. The integration re-applies `config.toml` to branches on every push, so a URL set only in the dashboard does not last:

```toml
[auth]
additional_redirect_urls = [
  "http://localhost:3000/**",
  "https://*-<worker>.<subdomain>.workers.dev/**",
]
```

`<worker>` is the Worker name and `<subdomain>` is your account's `workers.dev` subdomain (Workers and Pages, Account details, or `GET /accounts/{id}/workers/subdomain`).

## 3. Add a `previews` block

Previews inherit no bindings and no `vars` from the top level ([Cloudflare: configuration](https://developers.cloudflare.com/workers/previews/configuration/)). Redeclare every binding the Worker uses under `previews`, pointing storage at Preview-safe resources:

```jsonc
{
  "name": "my-app",
  "main": "src/worker.ts",
  "compatibility_flags": ["nodejs_compat"],
  "kv_namespaces": [{ "binding": "CACHE", "id": "<production namespace>" }],
  "vars": {
    "SUPABASE_URL": "https://<prod ref>.supabase.co",
    "SUPABASE_PUBLISHABLE_KEY": "...",
    "SUPABASE_PROJECT_REF": "<prod ref>",
  },
  "previews": {
    "kv_namespaces": [{ "binding": "CACHE", "id": "<preview namespace>" }],
    "vars": {},
  },
}
```

Leave `previews.vars` empty for now; the next step prints its values.

## 4. Create the shared Preview database

Put the tokens in `.env.swp` (git-ignore it), which every `swp` command loads when present:

```bash
SUPABASE_ACCESS_TOKEN=sbp_...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
```

[Tokens](tokens.md) lists the least-privilege scopes. Then:

```bash
npx swp shared --dry-run   # prints the plan
npx swp shared
```

Expected output:

```
Shared Preview database "preview" on <prod ref>, tracking main
  $ npx wrangler preview base-config secret bulk --worker-name my-app
Done: <preview ref>. Put these in the wrangler config under previews.vars:
{
  "SUPABASE_URL": "https://<preview ref>.supabase.co",
  "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_...",
  "SUPABASE_PROJECT_REF": "<preview ref>"
}
```

On a project that has never branched, an extra line reports how branching was enabled (`branching enabled on <ref>; ...`). `shared` waits until the branch holds every local migration, which can take several minutes, then sets the branch's auth Site URL and redirect wildcard and stores its secret key in the Preview base config as `SUPABASE_SERVICE_ROLE_KEY`.

Paste the printed object into `previews.vars`. These values are public (see [security](security.md)); commit them.

## 5. Wrap the Worker

```ts
import { withSupabasePreviews } from "supabase-worker-previews";
import app from "./app";

export default withSupabasePreviews(app);
```

In the browser, create the Supabase client from the injected config, with a fallback for a dev server that does not run the Worker:

```ts
import { createClient } from "@supabase/supabase-js";
import { readPublicConfig } from "supabase-worker-previews";

const { supabaseUrl, supabaseKey } = readPublicConfig() ?? {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
};
export const supabase = createClient(supabaseUrl, supabaseKey);
```

On the server, read Supabase settings from the handler's `env` (or `process.env` under `nodejs_compat`), never from `import { env } from "cloudflare:workers"`. The [framework guides](frameworks/) show where the entry lives for TanStack Start, Hono, React Router and Astro.

## 6. Check the setup

```bash
npx swp doctor
```

Expected output when everything is in place:

```
✓ wrangler 4.145.0
✓ previews.vars uses <preview ref>
✓ 20260913235959_api_default_privileges.sql grants the API roles default privileges
✓ "preview" (<preview ref>) tracks main
```

`✗` lines fail the command; `!` lines are warnings. Without `SUPABASE_ACCESS_TOKEN` it prints `! SUPABASE_ACCESS_TOKEN not set; skipped the online checks` and checks only the local files.

## 7. Turn on Preview builds

In the Cloudflare dashboard: **Workers and Pages, your Worker, Settings, Builds**.

| Setting                       | Value                  |
| ----------------------------- | ---------------------- |
| Production branch             | your trunk             |
| Non-production branch builds  | **enabled**            |
| Non-production deploy command | `npx wrangler preview` |

New Workers use `npx wrangler preview` by default ([Cloudflare: build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)). Use that literal command: the dashboard accepted nothing else when measured, and `swp` finds Previews by raw branch name for that reason. Keep the Worker's preview URLs turned on; turning them off takes every Preview down.

## 8. Add the GitHub Actions secrets

In the repo: **Settings, Secrets and variables, Actions**, add `SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The workflow `init` wrote passes them to `npx swp pr`, along with the job's `GITHUB_TOKEN`.

<!-- TODO(action): show the composite action (`uses: mattruby/supabase-worker-previews@v0`) as an alternative workflow once merged. -->

Commit `previews.vars`, the wrapped Worker and `config.toml`, and push to the trunk. The integration migrates the `preview` branch on trunk pushes.

## 9. Open a PR

**A PR that does not touch `supabase/`.** Workers Builds deploys its Preview with `previews.vars`, so it runs on the shared database. The "Preview database" check logs:

```
PR #12 (feat/header): the shared "preview" database
  Preview feat-header runs on preview (<preview ref>)
```

**A PR that changes `supabase/`** (or carries the `isolated-db` label). The integration creates a branch database, migrates and seeds it from the PR, and `swp pr` points the Preview at it:

```
PR #13 (feat/notes): its own database
Isolated database for feat/notes
  $ npx wrangler preview secret bulk --name feat/notes --worker-name my-app
Done: https://feat-notes-my-app.<subdomain>.workers.dev now runs on <branch ref>
  Preview feat-notes runs on feat/notes (<branch ref>)
```

While Workers Builds is still creating the Preview, `up` logs `waiting for the Preview of feat/notes to exist (n)`. `check` retries for up to 15 minutes while it waits for the right database.

Closing the PR runs `swp down`: it deletes the PR's Supabase branch if the integration has not already, then deletes the Preview.

<!-- TODO(pr-comment): describe the sticky PR comment once merged. -->
<!-- TODO(github-deployments): describe the GitHub Deployments entry once merged. -->
<!-- TODO(fork-prs): note that PRs from forks are skipped once merged. -->

Open the Preview URL and **sign in with a real browser**. A green check proves which database the page reads; signing in proves the grants and redirect URLs. If either fails, see [troubleshooting](troubleshooting.md).
