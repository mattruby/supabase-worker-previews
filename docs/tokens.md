# Tokens

The least-privilege credentials `swp` needs, what each call uses them for, and what is still unverified.

`swp` reads these credentials from the environment (or `.env.swp`):

| Variable                | Used by                                                                  | For                                                                |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN` | `doctor` (online checks), `shared`, `up`, `check`, `down`, `pr`, `prune` | the Supabase Management API                                        |
| `CLOUDFLARE_API_TOKEN`  | `shared`, `up`, `check`, `down`, `pr`, `prune`                           | wrangler and two Cloudflare API reads                              |
| `CLOUDFLARE_ACCOUNT_ID` | same                                                                     | the account those calls target                                     |
| `GITHUB_TOKEN`          | `pr`, `prune`                                                            | PR files, the PR comment, deployments, the repo's branches and PRs |

Items marked **unverified** could not be confirmed from official documentation as of 2026-09-30. Start from the least-privilege set below, and widen it only if a call fails with 401 or 403.

## Cloudflare API token

What `swp` does with it:

| Call                                                                                                      | Made by                                      |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `wrangler preview base-config secret bulk --worker-name <w>`                                              | `shared`                                     |
| `wrangler preview secret bulk --name <preview> --worker-name <w>`                                         | `up`                                         |
| `wrangler preview secret list --name <preview> --json --worker-name <w>`                                  | `pr` (shared path)                           |
| `wrangler preview secret delete SUPABASE_OVERRIDE --name <preview> --skip-confirmation --worker-name <w>` | `pr` (shared path, when an override is left) |
| `wrangler preview delete --name <preview> --skip-confirmation --worker-name <w>`                          | `down`, `pr` (on close), `prune --yes`       |
| `GET /accounts/{id}/workers/subdomain`                                                                    | `shared`, unless `workersSubdomain` is set   |
| `GET /accounts/{id}/workers/workers/{worker}/previews`                                                    | `up`, `check`, `down`, `pr`, `prune`         |

Create a custom token (My Profile, API Tokens, Create Token, Custom token) with:

| Scope   | Permission      | Access |
| ------- | --------------- | ------ |
| Account | Workers Scripts | Edit   |

Restrict it to the one account under **Account Resources**.

What is confirmed:

- The subdomain lookup accepts **Workers Scripts Write** or **Workers Scripts Read** ([API reference](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/)). The dashboard calls this permission "Edit"; the API reference calls it "Write" ([permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)).
- Cloudflare's Previews CI guide says "The API token needs permission to edit Workers Scripts and the resources used by the Preview" ([automation examples](https://developers.cloudflare.com/workers/previews/automation-examples/)).

**Unverified:**

- The exact permission for each Previews operation (secret bulk, list and delete, base-config secret bulk, Preview delete, and the Previews list). The REST API reference documents no Previews endpoints, so Workers Scripts Edit covering them is inferred from the CI guide above and from the equivalent non-Preview script secrets endpoint, which needs Workers Scripts Write ([API reference](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/)).
- Whether wrangler makes other calls (for example to read your memberships) that need **Account Settings Read** or **User Details Read** when `CLOUDFLARE_ACCOUNT_ID` is set. If wrangler fails with an authentication error, the [Edit Cloudflare Workers](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) template is the documented fallback; it is broader.
- "The resources used by the Preview" suggests a token that _deploys_ Previews needs edit access to the bound resources (KV, D1, R2). `swp` does not deploy (Workers Builds does), so it should not need them.

This token is separate from the one Workers Builds creates for itself ([Cloudflare: builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)). Do not reuse that one; it also edits KV, R2 and Workers Routes.

## Supabase access token

Supabase personal access tokens come in two kinds ([Supabase: personal access tokens](https://supabase.com/docs/guides/platform/personal-access-tokens)):

- **Classic** tokens (a **Legacy** badge in the dashboard) "carry your account's full access ... on every organization and every project you belong to today, and on every one you create or join in the future."
- **Scoped** tokens "carry only the organizations, projects, and permissions you choose", and never exceed what your account can do.

Use a scoped token with these permissions:

| Permission           | Access     | Why                                                                                                     |
| -------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| Project Settings     | Read       | `doctor` reads the production project (`GET /v1/projects/{ref}`)                                        |
| Development Branches | Read-write | list, create (`shared`, `up`), read, update (`shared`) and delete (`down`, `pr`, `prune`) branches      |
| Database             | Read-write | `POST /v1/projects/{branch ref}/database/query`, used only to count applied migrations                  |
| API Keys             | Read       | `GET /v1/projects/{branch ref}/api-keys?reveal=true` and `GET .../api-keys/legacy` (are legacy keys on) |
| API Key Secrets      | Read       | the same call, to reveal the secret key that goes into the Preview                                      |
| Auth Config          | Read-write | read and set the branch's Site URL and redirect list                                                    |
| Action Runs          | Read       | `doctor` reads `GET /v1/projects/{branch ref}/actions` to confirm the GitHub integration                |

Without API Key Secrets, the API returns secret keys masked and `swp` stops with `the access token cannot reveal secret API keys`. Without Action Runs, `doctor` cannot confirm the GitHub connection and warns.

**Organization or project scope.** Each branch is its own project with its own ref, and `swp` calls the query, API keys and auth endpoints on the branch's ref, including branches created after the token. Scope the token to the **organization**. A token scoped to one project listed no organizations when measured ([gotchas](../skills/supabase-worker-previews/references/gotchas.md#supabase-branches)).

**Unverified:**

- Whether a token scoped to the production project also reaches that project's branches. Not documented; use the organization scope.
- Whether a persistent branch (the shared `preview`) counts as a "development" or a "production" branch for these permissions. If `swp shared` fails with 403 on `PATCH /v1/branches/{ref}`, the token may also need **Production Branches: Read-write**. That widens it to the production branch record; `swp`'s own guard still refuses to touch it.
- Whether `PATCH /v1/projects/{ref}/config/auth` also needs **Project Settings: Read-write**.

**What the token can reach.** Database Read-write lets the holder run any SQL on every project in its scope, including production, and API Key Secrets Read reveals production's secret key. `swp` uses neither against production, but the token permits it. Store it only as a GitHub Actions secret and in a git-ignored `.env.swp`. See [security](security.md).

## GITHUB_TOKEN

| Call                                                                                                              | Made by           | Permission ([GitHub: permissions for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)) |
| ----------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /repos/{repo}/pulls/{n}/files`                                                                               | `pr`              | Pull requests: read                                                                                                                     |
| `GET /repos/{repo}/issues/{n}/comments`, `POST` there, `PATCH /repos/{repo}/issues/comments/{id}`                 | `pr` (comment)    | Pull requests: write (also listed under Issues: write)                                                                                  |
| `POST /repos/{repo}/deployments`, `GET` and `POST .../deployments/{id}/statuses`, `GET /repos/{repo}/deployments` | `pr` (deployment) | Deployments: write                                                                                                                      |
| `GET /repos/{repo}/pulls?state=open`, `GET /repos/{repo}/pulls?state=closed&head=...`                             | `prune`           | Pull requests: read                                                                                                                     |
| `GET /repos/{repo}/branches`                                                                                      | `prune`           | Contents: read                                                                                                                          |

The `swp pr` workflow templates set:

```yaml
permissions:
  contents: read # actions/checkout
  pull-requests: write # read the PR's files, keep the status comment
  deployments: write # record the GitHub deployment
```

`deployments: write` "permits an action to create a new deployment" ([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)). With `--no-comment` and `--no-deployments` (or the config fields set to `false`), `pull-requests: read` alone is enough for `swp pr`. If a permission is missing, the comment or deployment is skipped with a `::warning::` and the job still passes or fails on the database check alone.

A workflow that runs `swp prune` needs `contents: read` and `pull-requests: read`.

Setting any permission sets the unlisted ones to `none` ([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)), so the job has nothing else.

### Fork PRs

For PRs from forks, GitHub downgrades write permissions to read ([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)), and "with the exception of `GITHUB_TOKEN`, secrets are not passed to the runner when a workflow is triggered from a forked repository" ([GitHub: using secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)). `swp pr` therefore skips a PR whose head repository differs from the base repository (or was deleted) with a `::notice::`, and exits 0. A run with any of its four secrets empty fails with an `::error::`, except a bot's PR (Dependabot gets no Actions secrets), which is skipped with a `::warning::`.

---

[← Previous: Configuration](configuration.md) · [Docs index](README.md) · [Next: Security →](security.md)
