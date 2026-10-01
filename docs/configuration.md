# Configuration

Reference for every command, flag, environment variable and config field, the wrangler `previews` block, the GitHub Action, and the runtime API. Look things up here; [How it works](how-it-works.md) explains why they exist.

## Commands

`supabase-worker-previews --help` lists them in three groups; `supabase-worker-previews <command> --help` (or `supabase-worker-previews help <command>`) shows one command's flags and examples, and `supabase-worker-previews --version` (or `-v`) prints the version.

**Set up**

| Command                                                                                         | Does                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `supabase-worker-previews init [--project-ref <ref>] [--trunk <branch>] [--action] [--dry-run]` | Scaffold `supabase-worker-previews.json`, the grants migration and the PR workflow (never overwrites)                     |
| `supabase-worker-previews doctor`                                                               | Check wrangler, the `previews` block, bindings, static HTML, grants migration, auth redirects; with a token, Supabase too |
| `supabase-worker-previews shared`                                                               | Create or repair the shared Preview database; prints its `previews.vars`                                                  |

**Per branch**

| Command                                                                 | Does                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `supabase-worker-previews up [--branch <b>] [--pr <n>]`                 | Give a branch's Preview its own database                                      |
| `supabase-worker-previews check [--branch <b>] [--pr <n>] [--isolated]` | Fail unless the Preview serves the right database; fail at once on production |
| `supabase-worker-previews down [--branch <b>] [--pr <n>]`               | Delete the Preview and its own database                                       |

**In CI**

| Command                                                         | Does                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `supabase-worker-previews pr [--no-comment] [--no-deployments]` | Inside a `pull_request` workflow: `down` on close, else `up` or `release`, then `check`, and report on the PR |
| `supabase-worker-previews prune [--repo <owner/name>] [--yes]`  | List leftovers of deleted branches and closed PRs; delete them with `--yes`                                   |

- `--branch` defaults to `WORKERS_CI_BRANCH`, then `GITHUB_HEAD_REF`, then the current git branch.
- `--pr <n>` names the PR whose `pr-<n>` Preview to use when `previewName` is `"pr"`.
- `--isolated` makes `check` expect the branch's own database instead of the shared Preview database.
- `--repo` defaults to `GITHUB_REPOSITORY`, then the repo of the `origin` remote.
- `init --action` writes a workflow that uses the published [GitHub Action](#github-action) instead of `npx supabase-worker-previews pr`.

A mistyped command, flag or `supabase-worker-previews.json` key gets a suggestion (`Unknown command "sharde". Did you mean "supabase-worker-previews shared"?`). Unknown flags and stray arguments exit 2.

### Common flags

| Flag                  | Effect                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`           | Print the plan instead of changing anything; the output opens with `Dry run: reads only, changes nothing.` Not on `doctor`, which only reads |
| `--dotenv <path>`     | Load tokens from this file (default `.env.supabase-worker-previews` when it exists). Not `--env-file`: Node claims that flag for itself      |
| `--worker <name>`     | Overrides `worker` in `supabase-worker-previews.json`                                                                                        |
| `--project-ref <ref>` | Overrides `supabaseProjectRef`                                                                                                               |
| `--trunk <branch>`    | Overrides `trunk`                                                                                                                            |
| `-h`, `--help`        | Show help                                                                                                                                    |
| `-v`, `--version`     | Print the version                                                                                                                            |

`init` takes only `--project-ref`, `--trunk`, `--action` and `--dry-run`. `supabase-worker-previews <command> --help` lists exactly what each command accepts.

In `--dry-run`, `shared`, `up`, `check`, `down`, `pr` and `prune` still need `SUPABASE_ACCESS_TOKEN` (and `GITHUB_TOKEN` for `pr` and `prune`), because the reads still happen.

### Environment

| Variable                         | Needed by                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN`          | `shared`, `up`, `check`, `down`, `pr`, `prune`; `doctor` for its online checks |
| `CLOUDFLARE_API_TOKEN`           | `shared`, `up`, `check`, `down`, `pr`, `prune`                                 |
| `CLOUDFLARE_ACCOUNT_ID`          | the same                                                                       |
| `GITHUB_TOKEN`                   | `pr`, `prune`                                                                  |
| `SUPABASE_WORKER_PREVIEWS_DEBUG` | optional: set to `1` to print the stack trace of an error                      |

Put them in the shell, or in `.env.supabase-worker-previews` (or the file `--dotenv` names). A dotenv file may set only the five variables above; anything else in it, such as `NODE_OPTIONS`, is ignored, and a variable already set in the shell wins.

A command missing a token names each one and where to get it. A rejected token fails with one line ending `<TOKEN> is invalid or expired; see <tokens guide>`.

[Tokens](tokens.md) lists the least-privilege scopes for each.

## `supabase-worker-previews.json`

`supabase-worker-previews init` writes the first two fields. Everything else has a default.

| Field                   | Default         | Meaning                                                                               |
| ----------------------- | --------------- | ------------------------------------------------------------------------------------- |
| `supabaseProjectRef`    | (required)      | The production project. Previews must never serve it                                  |
| `worker`                | wrangler `name` | The Worker whose Previews `supabase-worker-previews` manages                          |
| `trunk`                 | `main`          | The git branch the shared Preview database tracks                                     |
| `sharedBranch`          | `preview`       | Name of the Supabase branch that is the shared Preview database                       |
| `supabaseDir`           | `supabase`      | A PR that changes files under it gets its own database                                |
| `isolatedLabel`         | `isolated-db`   | A PR with this label gets its own database even without a schema change               |
| `checkPath`             | `/`             | Page `check` scans for a Supabase URL when the identity route is absent               |
| `workersSubdomain`      | looked up       | Your `*.workers.dev` subdomain                                                        |
| `previewName`           | `"branch"`      | `"branch"`: Previews named after the git branch (Workers Builds). `"pr"`: `pr-<n>`    |
| `apiKeys`               | `"legacy"`      | Key pair to hand Previews when a branch has both: `"legacy"` (JWT) or `"new"` (`sb_`) |
| `prComment`             | `true`          | `supabase-worker-previews pr` keeps one status comment on the PR                      |
| `githubDeployments`     | `true`          | `supabase-worker-previews pr` records a GitHub deployment for the PR head             |
| `deploymentEnvironment` | `"Preview"`     | GitHub environment for those deployments; `{branch}` in it makes one per branch       |

[How it works](how-it-works.md) explains [`apiKeys`](how-it-works.md#which-api-keys) and [`previewName`](how-it-works.md#preview-names-previewname).

## The wrangler config

`supabase-worker-previews` reads the first of `wrangler.jsonc`, `wrangler.json` and `wrangler.toml` it finds. Previews inherit no bindings and no `vars` from the top level ([Cloudflare: configuration](https://developers.cloudflare.com/workers/previews/configuration/)), so the `previews` block redeclares every binding the Worker uses:

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

In `wrangler.toml` the same keys go under a `[previews]` table. `supabase-worker-previews shared` prints the three `previews.vars` values. They are public; commit them. The shared Preview database's secret key goes in the Preview base config as `SUPABASE_SERVICE_ROLE_KEY`, which `supabase-worker-previews shared` writes for you.

`doctor` checks that `previews.vars` exists, names the shared Preview database and not production, holds no secret, and that every top-level binding and var is redeclared.

## PR feedback

`supabase-worker-previews pr` keeps one status comment on the PR and records a GitHub deployment, which gives the PR a "View deployment" button. Neither can fail the job: a GitHub API error becomes a `::warning::` line. Neither is written in `--dry-run`.

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

Instead of calling `npx supabase-worker-previews pr`, a workflow can use the action ([full template](../templates/supabase-previews-action.yml)). Install your dependencies first: the action runs the project's own `supabase-worker-previews` and wrangler, and only when the package is not installed does it fall back to the exact version the action was released with. It never installs wrangler.

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  with:
    persist-credentials: false
- uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
  with:
    node-version: 24
    cache: npm
- run: npm ci --no-audit --no-fund
- uses: mattruby/supabase-worker-previews@v0 # or a release commit SHA, for a fixed version
  with:
    supabase-access-token: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
    cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    cloudflare-account-id: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

| Input                   | Default        | Effect                                                                    |
| ----------------------- | -------------- | ------------------------------------------------------------------------- |
| `command`               | `pr`           | The `supabase-worker-previews` command to run                             |
| `args`                  | (none)         | Extra arguments, such as `--dry-run`; split on spaces                     |
| `working-directory`     | `.`            | Directory holding `supabase-worker-previews.json` and the wrangler config |
| `version`               | the release's  | Exact version to download when the project does not install the package   |
| `github-token`          | `github.token` | Token for the PR comment and the deployment                               |
| `supabase-access-token` | (required)     | Organization-scoped Supabase access token                                 |
| `cloudflare-api-token`  | (required)     | Cloudflare API token that can manage the Worker's Previews                |
| `cloudflare-account-id` | (required)     | Cloudflare account ID                                                     |
| `comment`               | `"true"`       | `"false"` passes `--no-comment`                                           |
| `deployments`           | `"true"`       | `"false"` passes `--no-deployments`                                       |

See [action.yml](../action.yml).

## Runtime API

Import from `supabase-worker-previews` in the Worker and in the browser.

### `withSupabasePreviews(handler, options?)`

Wraps the Worker's default export. Every handler (`fetch`, `scheduled`, `queue`, ...) receives `env` with `SUPABASE_OVERRIDE` applied; `fetch` also injects the public config into HTML and answers the identity route.

| Option       | Default                 | Effect                                                                                                                                                                                                                                               |
| ------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `globalName` | `"__SUPABASE_PUBLIC__"` | Window property the config is written to; pass the same name to `readPublicConfig(name)`                                                                                                                                                             |
| `inject`     | `true`                  | Inject the public config into HTML                                                                                                                                                                                                                   |
| `identity`   | `true`                  | Serve `/.well-known/supabase-preview`                                                                                                                                                                                                                |
| `script`     | `"inline"`              | `"inline"` sets `window[globalName]` and reuses the `'nonce-...'` from your response's CSP `script-src` (or `default-src`) when it has one; `"json"` emits a non-executing `<script type="application/json">` block, for a strict CSP without nonces |

Read Supabase settings from the handler's `env`, or from `process.env` under `nodejs_compat`. Code that imports `env` from `cloudflare:workers` sees the raw values, not the override. The [framework guides](README.md#frameworks) show where each framework hands you `env`.

### `readPublicConfig(globalName?)`

In the browser, returns `{ supabaseUrl, supabaseKey }` as the Worker injected them (from the window global, or from the JSON block when `script: "json"`), or `null` when the page was not served through the Worker (a dev server), so you can fall back:

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

| Name                        | Where it comes from                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `SUPABASE_URL`              | `vars` (production), `previews.vars` (shared Preview database), the override         |
| `SUPABASE_PUBLISHABLE_KEY`  | the same                                                                             |
| `SUPABASE_PROJECT_REF`      | the same                                                                             |
| `SUPABASE_SERVICE_ROLE_KEY` | a secret: production's, the Preview base config, or the override                     |
| `SUPABASE_OVERRIDE`         | a Preview secret `supabase-worker-previews up` writes for a PR with its own database |

---

[← Previous: How it works](how-it-works.md) · [Docs index](README.md) · [Next: Tokens →](tokens.md)
