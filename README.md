# supabase-worker-previews

Vercel-style branch previews for a **Cloudflare Worker** on **Supabase**.

- Every git branch gets a [Worker Preview](https://developers.cloudflare.com/workers/) on a shared Preview database, never production.
- Every PR that changes `supabase/` gets its own Supabase branch database, migrated and seeded from the PR, and deleted when the PR closes.
- A CI check proves which database each Preview actually serves, and fails if it is production.

Cloudflare and Supabase each do most of this natively, but nothing connects them the way Vercel's Supabase integration does. This package is that connection: a CLI (`swp`), a small Worker wrapper, a one-step GitHub workflow, and a Claude Code skill documenting the platform behaviour it works around.

## How it fits together

| Piece                    | Owner                       | Role                                                                                      |
| ------------------------ | --------------------------- | ----------------------------------------------------------------------------------------- |
| Production deploy        | Workers Builds              | Your normal deploy on the trunk                                                           |
| Preview deploy           | Workers Builds              | `npx wrangler preview` on every other branch                                              |
| Shared Preview database  | Supabase                    | A persistent branch (`preview`) that tracks the trunk; the GitHub integration migrates it |
| Per-PR database          | Supabase GitHub integration | Created for PRs that change `supabase/`, deleted on close                                 |
| `previews.vars`          | your wrangler config        | The shared database's public URL and publishable key                                      |
| `SUPABASE_OVERRIDE`      | `swp pr`                    | One Preview secret pointing an isolated PR at its own database                            |
| `withSupabasePreviews()` | your Worker                 | Applies the override, hands the browser its Supabase config, answers `swp check`          |

One build serves any database: the Worker reads Supabase settings at request time and injects the public ones into each HTML page, so no `VITE_SUPABASE_URL`-style build-time values differ between environments.

## Setup

```bash
npm install --save-dev supabase-worker-previews
npx swp init --project-ref <production project ref>
```

`init` writes `swp.config.json`, a first migration that grants the API roles default privileges (see [why](skills/supabase-worker-previews/references/gotchas.md#supabase-branches)), and `.github/workflows/supabase-previews.yml`. Then:

1. **Supabase**: project settings, Integrations, GitHub. Connect the repo, turn on automatic branching, turn **off** "deploy to production" (your trunk deploy owns production migrations).
2. **Wrangler config**: add a `previews` block that redeclares every binding the Worker uses (Previews inherit none).
3. `npx swp shared`: creates the shared Preview database, stores its secret key in the Preview base config, and prints the `previews.vars` to paste in.
4. **Workers Builds**: enable non-production branch builds with the deploy command `npx wrangler preview`.
5. **GitHub Actions secrets**: `SUPABASE_ACCESS_TOKEN` (organization-scoped), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
6. Wrap the Worker and read the config in the browser:

```ts
// worker entry
import { withSupabasePreviews } from "supabase-worker-previews";
import app from "./app";
export default withSupabasePreviews(app);

// browser
import { readPublicConfig } from "supabase-worker-previews";
const { supabaseUrl, supabaseKey } = readPublicConfig() ?? {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL, // local dev server fallback
  supabaseKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
};
```

Handlers receive `env` with the override applied, and so does `process.env` under `nodejs_compat`. Code that imports `env` from `cloudflare:workers` sees the raw values, so read Supabase settings from the handler's `env` or `process.env`.

7. `npx swp doctor` checks all of it.

`wrangler.jsonc` ends up like:

```jsonc
{
  "name": "my-app",
  "main": "src/worker.ts",
  "kv_namespaces": [{ "binding": "CACHE", "id": "..." }],
  "previews": {
    "kv_namespaces": [{ "binding": "CACHE", "id": "..." }],
    "vars": {
      "SUPABASE_URL": "https://<preview branch ref>.supabase.co",
      "SUPABASE_PUBLISHABLE_KEY": "<its publishable key>",
      "SUPABASE_PROJECT_REF": "<preview branch ref>",
    },
  },
}
```

## Commands

| Command                               | Does                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `swp init`                            | Scaffold config, grants migration and workflow (never overwrites)                                                         |
| `swp doctor`                          | Check wrangler version, `previews` block, bindings, grants migration, auth redirects; with a token, the shared branch too |
| `swp shared`                          | Create or repair the shared Preview database                                                                              |
| `swp up --branch <b>`                 | Give a branch's Preview its own database                                                                                  |
| `swp check --branch <b> [--isolated]` | Fail unless the Preview serves the right database; fail at once on production                                             |
| `swp down --branch <b>`               | Delete the Preview and its own database                                                                                   |
| `swp pr`                              | Inside a `pull_request` workflow: `down` on close, else `up` when needed, then `check`                                    |

Every command takes `--dry-run`, and `--env-file <path>` (default `.env.swp` when present). `swp.config.json`:

| Field                | Default         |                                                      |
| -------------------- | --------------- | ---------------------------------------------------- |
| `supabaseProjectRef` | (required)      | The production project                               |
| `worker`             | wrangler `name` |                                                      |
| `trunk`              | `main`          | The branch the shared Preview database tracks        |
| `sharedBranch`       | `preview`       | Name of that Supabase branch                         |
| `supabaseDir`        | `supabase`      | Changes under it give a PR its own database          |
| `isolatedLabel`      | `isolated-db`   | PR label that asks for one anyway                    |
| `checkPath`          | `/`             | Page `check` scans when the identity route is absent |
| `workersSubdomain`   | looked up       | Your `*.workers.dev` subdomain                       |

## Pull request feedback

`swp pr` keeps one comment on the PR (Preview URL, which database it serves, pass or fail with the reason, the commit) and records a GitHub deployment, which gives the PR a "View deployment" button. On close, the comment says what was removed and the deployments are marked inactive. GitHub API errors (a fork's read-only token, missing permissions, rate limits) become `::warning::` lines; only the database check fails the job. Turn either off with `"prComment": false` or `"githubDeployments": false` in `swp.config.json`, or `--no-comment` / `--no-deployments`. Deployments share one transient environment, `Preview` (set `"deploymentEnvironment"`; `"Preview: {branch}"` gives one per branch), and each PR only ever retires its own. The workflow needs:

```yaml
permissions:
  contents: read
  pull-requests: write
  deployments: write
```

### GitHub Action

Instead of installing the package and calling `npx swp pr`, a workflow can use the action ([full template](templates/supabase-previews-action.yml)). It runs the project's installed `swp` when there is one, else `supabase-worker-previews@<version>`.

```yaml
- uses: actions/checkout@v4
- uses: mattruby/supabase-worker-previews@v0
  with:
    supabase-access-token: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
    cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    cloudflare-account-id: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    # working-directory: apps/web   version: "0"   comment: "false"   deployments: "false"   args: --dry-run
```

## Safety

- `swp` never writes to, repoints or deletes the production project through a branch record, and never deletes a persistent branch.
- `check` fails the first time a Preview serves production.
- `doctor` fails if `previews.vars` names production or holds a secret.

## Claude Code plugin

The repo is also a Claude Code plugin whose skill carries the measured platform behaviour (`skills/supabase-worker-previews`):

```
/plugin marketplace add mattruby/supabase-worker-previews
/plugin install supabase-worker-previews
```

## License

MIT
