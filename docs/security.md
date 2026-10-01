# Security

## What `swp` touches

| System                      | Reads                                                                            | Writes                                                                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase production project | the project record, its branch list                                              | no SQL, keys or auth settings. Branches are created through its `POST /v1/projects/{ref}/branches` endpoint. On a project that has never branched, `shared` first creates and deletes a throwaway branch named `production`, which can relabel the project's own default branch as `production` |
| Supabase branch databases   | status, `supabase_migrations.schema_migrations` row count, API keys, auth config | create and update the shared branch (`shared`); create a PR branch when the integration has not (`up`); set Site URL and add redirect URLs (`shared`, `up`); delete a non-persistent PR branch (`down`)                                                                                         |
| Cloudflare                  | the account's `workers.dev` subdomain, the Worker's Previews list                | the Preview base config secret `SUPABASE_SERVICE_ROLE_KEY` (`shared`); the `SUPABASE_OVERRIDE` secret on one Preview (`up`); delete one Preview (`down`)                                                                                                                                        |
| GitHub                      | the PR's changed files                                                           | nothing                                                                                                                                                                                                                                                                                         |
| Your repo                   | `swp.config.json`, the wrangler config, `supabase/`                              | `swp init` only, and it never overwrites a file                                                                                                                                                                                                                                                 |

`swp` never deploys code, never touches the production Worker's secrets or vars, and never runs SQL on, reads the keys of, or changes the auth settings of the production project.

<!-- TODO(pr-comment): add the PR comment write to the GitHub row once merged. -->
<!-- TODO(github-deployments): add Deployments writes to the GitHub row once merged. -->
<!-- TODO(prune): add what `swp prune` deletes once merged. -->

## Guards

Enforced in code:

- **Production is never a branch target.** `assertIsolated` refuses any branch record that is the default branch or whose ref equals `supabaseProjectRef`, before `shared`, `up`, `check` or `down` acts on it: `Supabase branch "<name>" is the production project <ref> itself; refusing to touch it`.
- **Persistent branches are never deleted.** `down` skips a branch marked persistent, including the shared `preview` branch.
- **Production fails the check at once.** If a Preview serves the production ref, `check` throws without retrying.
- **Secrets stay out of committed config.** `doctor` fails if `previews.vars` contains `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_OVERRIDE`, or points at the production ref.
- **A broken override fails loudly.** A `SUPABASE_OVERRIDE` missing any of its four values throws instead of falling back to another database.
- **Dry runs.** Every command takes `--dry-run` and prints the wrangler commands and writes it would make.

These guards protect against `swp` mistakes. They do not limit what the tokens themselves can do.

## Public vs secret

| Value                                               | Where it lives                                                     | Public?                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Project and branch refs                             | `swp.config.json`, `previews.vars`, the identity route             | Yes. The ref is the hostname of every API request the browser makes          |
| `SUPABASE_URL`                                      | `previews.vars`, injected into every HTML page, the identity route | Yes                                                                          |
| `SUPABASE_PUBLISHABLE_KEY` (or legacy `anon` key)   | `previews.vars`, injected into every HTML page                     | Yes. It is meant for browsers; Row Level Security is what protects your data |
| `SUPABASE_SERVICE_ROLE_KEY` (or the new secret key) | Preview base config secret, inside `SUPABASE_OVERRIDE`             | **No.** Bypasses Row Level Security                                          |
| `SUPABASE_OVERRIDE`                                 | one Preview's secret                                               | **No.** Holds a secret key                                                   |
| `SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN`     | GitHub Actions secrets, `.env.swp`                                 | **No**                                                                       |
| `CLOUDFLARE_ACCOUNT_ID`                             | GitHub Actions secrets                                             | Low sensitivity, but there is no reason to publish it                        |

The injected script and the identity route expose only the URL, publishable key and ref. They never include the secret key: `publicConfigFromEnv` reads only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, and `identityResponse` only the URL and ref.

Preview URLs are public by default. Anyone who guesses `https://<branch>-<worker>.<subdomain>.workers.dev` reaches a Preview, and its Worker holds a secret key for its database, so any endpoint of yours that uses that key is reachable too. Keep real customer data out of branch databases (`seed.sql` should be synthetic). Restricting who can open Preview URLs is outside `swp`; check Cloudflare's current options for your plan.

Add `.env.swp` to `.gitignore`.

## Token blast radius

Least-privilege scopes are in [tokens](tokens.md). What a leaked token allows:

**`SUPABASE_ACCESS_TOKEN`**, scoped to the organization as recommended:

- Run any SQL on any project in the organization, **production included** (Database: Read-write).
- Reveal every project's secret key (API Key Secrets: Read), which bypasses Row Level Security.
- Create, change and delete development branches; change auth redirect settings.

A classic (legacy) token is worse: every organization you belong to, with every permission. This is the most dangerous credential in the setup. Rotate it if exposed, and prefer a dedicated account or organization member with only the access `swp` needs.

**`CLOUDFLARE_API_TOKEN`** with Workers Scripts: Edit:

- Deploy, change secrets on, or delete any Worker in the account, **production included**, not only Previews.

Restrict it to one account. Cloudflare tokens can also be limited by client IP and expiry, but GitHub-hosted runners have no fixed IP.

**`GITHUB_TOKEN`**: issued per job by GitHub, read-only for contents and pull requests, expires when the job ends.

## Fork PRs

GitHub does not pass repository secrets to `pull_request` workflows from forks ([GitHub: using secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)), so the template workflow cannot leak your tokens to a fork's code; `swp pr` fails there with `Missing SUPABASE_ACCESS_TOKEN in the environment`. Do not switch the workflow to `pull_request_target` to make fork PRs work: that runs with your secrets on a checkout of untrusted code.

<!-- TODO(fork-prs): describe fork-PR skipping once merged. -->

## Reporting a vulnerability

Open a [GitHub security advisory](https://github.com/mattruby/supabase-worker-previews/security/advisories/new) on the repository rather than a public issue.
