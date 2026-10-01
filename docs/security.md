# Security

What `supabase-worker-previews` can read and write, the guards that stop it touching production, which values are public, and what a leaked token allows.

## What `supabase-worker-previews` touches

| System                      | Reads                                                                                         | Writes                                                                                                                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase production project | the project record, its branch list                                                           | no SQL, keys, auth settings or branch record. New branches are created through its `POST /v1/projects/{ref}/branches` endpoint; `shared` refuses a project that has no branching instead of creating its first branch                           |
| Supabase branch databases   | status, `supabase_migrations.schema_migrations` row count, API keys, auth config, action runs | create and update the shared branch (`shared`); create a PR branch when the integration has not (`up`); set Site URL and add redirect URLs (`shared`, `up`); delete a PR's own branch (`down`, `pr` when it is no longer needed, `prune --yes`) |
| Cloudflare                  | the account's `workers.dev` subdomain, the Worker's Previews list, a Preview's secret names   | the Preview base config secret `SUPABASE_SERVICE_ROLE_KEY` (`shared`); set (`up`) or delete (`pr`) the `SUPABASE_OVERRIDE` secret on one Preview; delete Previews (`down`, `prune --yes`)                                                       |
| GitHub                      | the PR's changed files, its comments, deployments; for `prune`, the repo's branches and PRs   | one status comment per PR (`pr`); deployments and deployment statuses in the `Preview` environment (`pr`)                                                                                                                                       |
| Your repo                   | `supabase-worker-previews.json`, the wrangler config, `supabase/`                             | `supabase-worker-previews init` only, and it never overwrites a file                                                                                                                                                                            |

`supabase-worker-previews` never deploys code, never touches the production Worker's secrets or vars, never writes to the production project's branch record, and never runs SQL on, reads the keys of, or changes the auth settings of the production project.

## Guards

Enforced in code:

- **Production is never a branch target.** `assertIsolated` refuses any branch record that is the default branch or whose ref equals `supabaseProjectRef`, before `shared`, `up`, `check`, `down`, `release` (in `supabase-worker-previews pr`) or `prune` acts on it: `Supabase branch "<name>" is the production project <ref> itself; refusing to touch it`.
- **Persistent branches are never deleted.** `down` skips a branch marked persistent, including the shared `preview` branch. When `supabase-worker-previews pr` drops a database a PR no longer needs, and in `prune`, a branch must also not be the shared branch or track the trunk.
- **No first branch on production.** `shared` refuses a project without branching (`Branching is not enabled on <ref>. ...`) rather than creating its first branch, which was seen to relabel the production project's own branch record.
- **Prune plans first.** `prune` only lists leftovers until you pass `--yes`, never deletes in `--dry-run`, and never deletes the trunk's Preview.
- **Masked keys are refused.** If the token cannot reveal secret keys, `supabase-worker-previews` stops instead of writing a masked key into a Preview.
- **Production fails the check at once.** If a Preview serves the production ref, `check` throws without retrying.
- **Secrets stay out of committed config.** `doctor` fails if `previews.vars` contains `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_OVERRIDE`, or points at the production ref.
- **A broken override fails loudly.** A `SUPABASE_OVERRIDE` missing any of its four values throws instead of falling back to another database.
- **Dry runs.** Every command that changes something (all but `doctor`) takes `--dry-run` and prints the wrangler commands and writes it would make. `supabase-worker-previews pr` writes no comment or deployment in a dry run.

These guards protect against `supabase-worker-previews` mistakes. They do not limit what the tokens themselves can do.

## Public vs secret

| Value                                               | Where it lives                                                       | Public?                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Project and branch refs                             | `supabase-worker-previews.json`, `previews.vars`, the identity route | Yes. The ref is the hostname of every API request the browser makes          |
| `SUPABASE_URL`                                      | `previews.vars`, injected into every HTML page, the identity route   | Yes                                                                          |
| `SUPABASE_PUBLISHABLE_KEY` (or legacy `anon` key)   | `previews.vars`, injected into every HTML page                       | Yes. It is meant for browsers; Row Level Security is what protects your data |
| `SUPABASE_SERVICE_ROLE_KEY` (or the new secret key) | Preview base config secret, inside `SUPABASE_OVERRIDE`               | **No.** Bypasses Row Level Security                                          |
| `SUPABASE_OVERRIDE`                                 | one Preview's secret                                                 | **No.** Holds a secret key                                                   |
| `SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN`     | GitHub Actions secrets, `.env.supabase-worker-previews`              | **No**                                                                       |
| `CLOUDFLARE_ACCOUNT_ID`                             | GitHub Actions secrets                                               | Low sensitivity, but there is no reason to publish it                        |

The injected script and the identity route expose only the URL, publishable key and ref. They never include the secret key: `publicConfigFromEnv` reads only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, and `identityResponse` only the URL and ref.

Preview URLs are public by default. Anyone who guesses `https://<branch>-<worker>.<subdomain>.workers.dev` reaches a Preview, and its Worker holds a secret key for its database, so any endpoint of yours that uses that key is reachable too. Keep real customer data out of branch databases (`seed.sql` should be synthetic). Restricting who can open Preview URLs is outside `supabase-worker-previews`; check Cloudflare's current options for your plan.

Add `.env.supabase-worker-previews` to `.gitignore`.

## Token blast radius

Least-privilege scopes are in [tokens](tokens.md). What a leaked token allows:

**`SUPABASE_ACCESS_TOKEN`**, scoped to the organization as recommended:

- Run any SQL on any project in the organization, **production included** (Database: Read-write).
- Reveal every project's secret key (API Key Secrets: Read), which bypasses Row Level Security.
- Create, change and delete development branches; change auth redirect settings.

A classic (legacy) token is worse: every organization you belong to, with every permission. This is the most dangerous credential in the setup. Rotate it if exposed, and prefer a dedicated account or organization member with only the access `supabase-worker-previews` needs.

**`CLOUDFLARE_API_TOKEN`** with Workers Scripts: Edit:

- Deploy, change secrets on, or delete any Worker in the account, **production included**, not only Previews.

Restrict it to one account. Cloudflare tokens can also be limited by client IP and expiry, but GitHub-hosted runners have no fixed IP.

**`GITHUB_TOKEN`**: issued per job by GitHub and expires when the job ends. The `supabase-worker-previews pr` templates grant `contents: read`, `pull-requests: write` and `deployments: write`, so a misuse could edit PR comments or create deployments in this repository, nothing more.

## Fork PRs

GitHub does not pass repository secrets to `pull_request` workflows from forks ([GitHub: using secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)), so the template workflow cannot leak your tokens to a fork's code. `supabase-worker-previews pr` skips fork PRs (head repository differs from the base, or was deleted) with a `::notice::`, and exits 0; a run with any secret empty stops with an `::error::` (or a `::warning::` for a bot's PR), in both cases before it creates any API client. Do not switch the workflow to `pull_request_target` to make fork PRs work: that runs with your secrets on a checkout of untrusted code.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md). Open a [GitHub security advisory](https://github.com/mattruby/supabase-worker-previews/security/advisories/new) on the repository rather than a public issue.

---

[← Previous: Tokens](tokens.md) · [Docs index](README.md) · [Next: Compared with Vercel →](vs-vercel.md)
