# Configuration

Reference for every command, flag, environment variable and config field, the wrangler `previews` block, the GitHub Action, and the runtime API. Look things up here; [How it works](how-it-works.md) explains why they exist.

## Commands

| Command                                             | Does                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `swp init [--project-ref <ref>] [--trunk <branch>]` | Scaffold config, grants migration and workflow (never overwrites)                                                         |
| `swp doctor`                                        | Check wrangler, the `previews` block, bindings, static HTML, grants migration, auth redirects; with a token, Supabase too |
| `swp shared`                                        | Create or repair the shared Preview database                                                                              |
| `swp up [--branch <b>] [--pr <n>]`                  | Give a branch's Preview its own database                                                                                  |
| `swp check [--branch <b>] [--pr <n>] [--isolated]`  | Fail unless the Preview serves the right database; fail at once on production                                             |
| `swp down [--branch <b>] [--pr <n>]`                | Delete the Preview and its own database                                                                                   |
| `swp pr`                                            | Inside a `pull_request` workflow: `down` on close, else `up` or `release`, then `check`, and report on the PR             |
| `swp prune [--repo <owner/name>] [--yes]`           | List leftovers of deleted branches and closed PRs; delete them with `--yes`                                               |

`swp help` (or `--help`) prints the same summary.

- `--branch` defaults to `WORKERS_CI_BRANCH`, then `GITHUB_HEAD_REF`, then the current git branch.
- `--pr <n>` names the PR whose `pr-<n>` Preview to use when `previewName` is `"pr"`.
- `--isolated` makes `check` expect the branch's own database instead of the shared Preview database.
- `--repo` defaults to `GITHUB_REPOSITORY`.

### Flags for every command

| Flag                  | Effect                                                                        |
| --------------------- | ----------------------------------------------------------------------------- |
| `--dry-run`           | Print the wrangler commands and API writes instead of making them             |
| `--env-file <path>`   | Load environment variables from this file (default `.env.swp` when it exists) |
| `--worker <name>`     | Overrides `worker` in `swp.config.json`                                       |
| `--project-ref <ref>` | Overrides `supabaseProjectRef`                                                |
| `--trunk <branch>`    | Overrides `trunk`                                                             |

`swp pr` also takes `--no-comment` and `--no-deployments`.

In `--dry-run`, `shared`, `up`, `check`, `down`, `pr` and `prune` still need `SUPABASE_ACCESS_TOKEN` (and `GITHUB_TOKEN` for `pr` and `prune`), because the reads still happen.

### Environment

| Variable                | Needed by                                                                      |
| ----------------------- | ------------------------------------------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN` | `shared`, `up`, `check`, `down`, `pr`, `prune`; `doctor` for its online checks |
| `CLOUDFLARE_API_TOKEN`  | `shared`, `up`, `check`, `down`, `pr`, `prune`                                 |
| `CLOUDFLARE_ACCOUNT_ID` | the same                                                                       |
| `GITHUB_TOKEN`          | `pr`, `prune`                                                                  |

[Tokens](tokens.md) lists the least-privilege scopes for each.

## `swp.config.json`

`swp init` writes the first two fields. Everything else has a default.

| Field                   | Default         | Meaning                                                                               |
| ----------------------- | --------------- | ------------------------------------------------------------------------------------- |
| `supabaseProjectRef`    | (required)      | The production project. Previews must never serve it                                  |
| `worker`                | wrangler `name` | The Worker whose Previews `swp` manages                                               |
| `trunk`                 | `main`          | The git branch the shared Preview database tracks                                     |
| `sharedBranch`          | `preview`       | Name of the Supabase branch that is the shared Preview database                       |
| `supabaseDir`           | `supabase`      | A PR that changes files under it gets its own database                                |
| `isolatedLabel`         | `isolated-db`   | A PR with this label gets its own database even without a schema change               |
| `checkPath`             | `/`             | Page `check` scans for a Supabase URL when the identity route is absent               |
| `workersSubdomain`      | looked up       | Your `*.workers.dev` subdomain                                                        |
| `previewName`           | `"branch"`      | `"branch"`: Previews named after the git branch (Workers Builds). `"pr"`: `pr-<n>`    |
| `apiKeys`               | `"legacy"`      | Key pair to hand Previews when a branch has both: `"legacy"` (JWT) or `"new"` (`sb_`) |
| `prComment`             | `true`          | `swp pr` keeps one status comment on the PR                                           |
| `githubDeployments`     | `true`          | `swp pr` records a GitHub deployment for the PR head                                  |
| `deploymentEnvironment` | `"Preview"`     | GitHub environment for those deployments; `{branch}` in it makes one per branch       |

[How it works](how-it-works.md) explains [`apiKeys`](how-it-works.md#which-api-keys) and [`previewName`](how-it-works.md#preview-names-previewname).

## The wrangler config

`swp` reads the first of `wrangler.jsonc`, `wrangler.json` and `wrangler.toml` it finds. Previews inherit no bindings and no `vars` from the top level ([Cloudflare: configuration](https://developers.cloudflare.com/workers/previews/configuration/)), so the `previews` block redeclares every binding the Worker uses:

```jsonc
{
  "name": "my-app",
  "main": "src/worker.ts",
  "kv_namespaces": [{ "binding": "CACHE", "id": "<production namespace>" }],
  "vars": {
    "SUPABASE_URL": "https://<production ref>.supabase.co",
    "SUPABASE_PUBLISHABLE_KEY": "<production publishable key>",
    "SUPABASE_PROJECT_REF": "<production ref>",
  },
  "previews": {
    "kv_namespaces": [{ "binding": "CACHE", "id": "<preview namespace>" }],
    "vars": {
      "SUPABASE_URL": "https://<preview branch ref>.supabase.co",
      "SUPABASE_PUBLISHABLE_KEY": "<its publishable key>",
      "SUPABASE_PROJECT_REF": "<preview branch ref>",
    },
  },
}
```

In `wrangler.toml` the same keys go under a `[previews]` table. `swp shared` prints the three `previews.vars` values. They are public; commit them. The shared Preview database's secret key goes in the Preview base config as `SUPABASE_SERVICE_ROLE_KEY`, which `swp shared` writes for you.

`doctor` checks that `previews.vars` exists, names the shared Preview database and not production, holds no secret, and that every top-level binding and var is redeclared.

## PR feedback

`swp pr` keeps one status comment on the PR and records a GitHub deployment, which gives the PR a "View deployment" button. Neither can fail the job: a GitHub API error becomes a `::warning::` line. Neither is written in `--dry-run`.

| To                                   | Set                                                 |
| ------------------------------------ | --------------------------------------------------- |
| Turn off the comment                 | `"prComment": false`, or `--no-comment`             |
| Turn off the deployment              | `"githubDeployments": false`, or `--no-deployments` |
| Give each branch its own environment | `"deploymentEnvironment": "Preview: {branch}"`      |

The workflow needs:

```yaml
permissions:
  contents: read
  pull-requests: write # the status comment
  deployments: write # the GitHub deployment
```

## GitHub Action

Instead of installing the package and calling `npx swp pr`, a workflow can use the action ([full template](../templates/supabase-previews-action.yml)). It runs the project's installed `swp` when there is one, else `supabase-worker-previews@<version>`.

```yaml
- uses: actions/checkout@v4
- uses: mattruby/supabase-worker-previews@v0
  with:
    supabase-access-token: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
    cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    cloudflare-account-id: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

| Input                   | Default        | Effect                                                      |
| ----------------------- | -------------- | ----------------------------------------------------------- |
| `command`               | `pr`           | The `swp` command to run                                    |
| `args`                  | (none)         | Extra arguments, such as `--dry-run`; split on spaces       |
| `working-directory`     | `.`            | Directory holding `swp.config.json` and the wrangler config |
| `version`               | `"0"`          | Version to download when the project does not install `swp` |
| `github-token`          | `github.token` | Token for the PR comment and the deployment                 |
| `supabase-access-token` | (required)     | Organization-scoped Supabase access token                   |
| `cloudflare-api-token`  | (required)     | Cloudflare API token that can manage the Worker's Previews  |
| `cloudflare-account-id` | (required)     | Cloudflare account ID                                       |
| `comment`               | `"true"`       | `"false"` passes `--no-comment`                             |
| `deployments`           | `"true"`       | `"false"` passes `--no-deployments`                         |

See [action.yml](../action.yml).

## Runtime API

Import from `supabase-worker-previews` in the Worker and in the browser.

### `withSupabasePreviews(handler, options?)`

Wraps the Worker's default export. Every handler (`fetch`, `scheduled`, `queue`, ...) receives `env` with `SUPABASE_OVERRIDE` applied; `fetch` also injects the public config into HTML and answers the identity route.

| Option       | Default                 | Effect                                                                                   |
| ------------ | ----------------------- | ---------------------------------------------------------------------------------------- |
| `globalName` | `"__SUPABASE_PUBLIC__"` | Window property the config is written to; pass the same name to `readPublicConfig(name)` |
| `inject`     | `true`                  | Inject the public config into HTML                                                       |
| `identity`   | `true`                  | Serve `/.well-known/supabase-preview`                                                    |

Read Supabase settings from the handler's `env`, or from `process.env` under `nodejs_compat`. Code that imports `env` from `cloudflare:workers` sees the raw values, not the override. The [framework guides](README.md#frameworks) show where each framework hands you `env`.

### `readPublicConfig(globalName?)`

In the browser, returns `{ supabaseUrl, supabaseKey }` as the Worker injected them, or `null` when the page was not served through the Worker (a dev server), so you can fall back:

```ts
import { createClient } from "@supabase/supabase-js";
import { readPublicConfig } from "supabase-worker-previews";

const { supabaseUrl, supabaseKey } = readPublicConfig() ?? {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
};
export const supabase = createClient(supabaseUrl, supabaseKey);
```

### The Worker's Supabase variables

| Name                        | Where it comes from                                                          |
| --------------------------- | ---------------------------------------------------------------------------- |
| `SUPABASE_URL`              | `vars` (production), `previews.vars` (shared Preview database), the override |
| `SUPABASE_PUBLISHABLE_KEY`  | the same                                                                     |
| `SUPABASE_PROJECT_REF`      | the same                                                                     |
| `SUPABASE_SERVICE_ROLE_KEY` | a secret: production's, the Preview base config, or the override             |
| `SUPABASE_OVERRIDE`         | a Preview secret `swp up` writes for a PR with its own database              |

---

[← Previous: How it works](how-it-works.md) · [Docs index](README.md) · [Next: Tokens →](tokens.md)
