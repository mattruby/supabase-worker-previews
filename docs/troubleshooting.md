# Troubleshooting

Find your symptom below, then follow its cause and fix. Each heading is phrased the way the problem shows up.

- [Signed-in reads fail with 403 or permission denied](#signed-in-reads-fail-with-403-or-permission-denied)
- [My Preview shows production data](#my-preview-shows-production-data)
- [My Preview still uses an old database](#my-preview-still-uses-an-old-database)
- [The Preview database check never passes](#the-preview-database-check-never-passes)
- [A deleted Preview still loads](#a-deleted-preview-still-loads)
- [Sign-in links and OAuth redirect to localhost](#sign-in-links-and-oauth-redirect-to-localhost)
- [A binding or secret is undefined only in Previews](#a-binding-or-secret-is-undefined-only-in-previews)
- [`supabase-worker-previews shared` or `supabase-worker-previews up` hangs, then says the branch is not ready](#supabase-worker-previews-shared-or-supabase-worker-previews-up-hangs-then-says-the-branch-is-not-ready)
- [Cannot create Supabase branch](#cannot-create-supabase-branch)
- [The PR check is green but nothing happened](#the-pr-check-is-green-but-nothing-happened)
- [No PR comment or View deployment button](#no-pr-comment-or-view-deployment-button)
- [The access token cannot reveal secret API keys](#the-access-token-cannot-reveal-secret-api-keys)
- [`node: .env.supabase-worker-previews: not found` or exit code 9](#node-envsupabase-worker-previews-not-found-or-exit-code-9)
- [A token is invalid or expired](#a-token-is-invalid-or-expired)
- [Upgrading from 0.1: `swp` is not found](#upgrading-from-01-swp-is-not-found)
- [`wrangler is not installed in this project`](#wrangler-is-not-installed-in-this-project)
- [`prune` says the repo has no branch named after the trunk](#prune-says-the-repo-has-no-branch-named-after-the-trunk)
- [`up` refuses the trunk or a persistent branch](#up-refuses-the-trunk-or-a-persistent-branch)

## Start here

Run these first:

```bash
npx supabase-worker-previews doctor                       # local files, plus the shared branch when SUPABASE_ACCESS_TOKEN is set
npx supabase-worker-previews check --branch <git branch>  # which database the Preview serves right now
```

Then confirm with a real browser: open the Preview, sign in, and load a page that reads data. A deploy that exits 0 and a check that passes tell you which database the page names, not that signed-in reads work.

The platform behaviour cited below was measured and is recorded in [gotchas.md](../skills/supabase-worker-previews/references/gotchas.md).

## Signed-in reads fail with 403 or permission denied

**Symptom.** The Preview loads and sign-in works, but reads return 403 or `permission denied for table ...`. Production is fine.

**Cause.** The branch database's tables have only owner privileges. Supabase branches, and newer projects, start without default privileges for the `anon`, `authenticated` and `service_role` roles, so tables created by your migrations are not readable through the API. Two ways to get there:

- The branch was created through the Management API while the project was **not** linked to GitHub. Supabase then copies the parent's schema **without privileges** and ignores `git_branch`.
- The grants migration is missing, or is not the first migration, so tables were created before it ran.

**Fix.**

1. `npx supabase-worker-previews doctor`. If it reports `the first migration (...) does not grant default privileges; branch databases will 403`, run `npx supabase-worker-previews init`, which writes the grants migration dated before your first one, and apply it to production as `init` instructs.
2. Make sure the Supabase GitHub integration is connected (Project Settings, Integrations, GitHub) before any branch is created. With `SUPABASE_ACCESS_TOKEN` set, `doctor` checks this:
   - `branching is not enabled on <ref>` when the project has no default branch.
   - `✓ Supabase builds "<branch>" from GitHub <owner>/<repo>, so branches run the repo's migrations` when it finds proof of the connection.
   - `! cannot confirm the Supabase GitHub integration: ...` when it finds none.

   The Management API has no field for whether a project is connected to GitHub. `doctor` instead reads the action runs (`GET /v1/projects/{branch ref}/actions`) of up to five branches, the shared branch first, and looks for a run that carries `git_config` with the repo, which only integration-made runs have. It cannot know about branches past those five, or whether a particular older branch was created before the repo was connected, and a branch that has had no integration run yet (for example, connected but never pushed since) gives no proof either way. If you have connected the repo and still get the warning, push to the trunk and run `doctor` again.

3. Rebuild the broken branch so it runs the migrations from scratch:
   - **A PR's branch:** close and reopen the PR. The integration deletes the branch on close and creates it again on reopen. Closing also runs `supabase-worker-previews down`, which deletes the Preview, so push a commit afterwards to have Workers Builds recreate it.
   - **The shared `preview` branch:** persistent branches refuse `DELETE`, so first `PATCH /v1/branches/{ref}` with `{"persistent": false}`, then delete it, then run `npx supabase-worker-previews shared` again and paste the new `previews.vars`.

## My Preview shows production data

**Symptom.** A Preview reads or writes production rows.

`supabase-worker-previews check` would fail at once with `Preview <slug> serves the production database <ref>; refusing to pass` if the page named production. If the check is green but the browser still talks to production, the browser is not using the injected config.

**Causes and fixes.**

| Cause                                                                                                                                                                                                                                                                                     | How to tell                                                                                                                                                                                                                                          | Fix                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `previews.vars` names production                                                                                                                                                                                                                                                          | `doctor`: `previews.vars points at the production project <ref>`                                                                                                                                                                                     | Run `npx supabase-worker-previews shared` and paste its output into `previews.vars`                                             |
| `previews.vars` is empty, so the Worker has no `SUPABASE_URL` and injects nothing, and the browser falls back to build-time `VITE_*` values that point at production                                                                                                                      | `doctor`: `previews.vars needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY`; in the browser, `window.__SUPABASE_PUBLIC__` is undefined                                                                                                                 | Fill `previews.vars`. Keep production values out of the build environment Preview builds see                                    |
| The HTML never passes through the Worker. With [static assets](https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first), a request that matches an asset (such as an SPA's `index.html`) is served without invoking the Worker unless `run_worker_first` is set | `doctor` warns `<dir> has <files>.html; Cloudflare serves matching assets without running the Worker, ...` when the assets directory holds HTML and `run_worker_first` is unset; `view-source:` on the Preview shows no `__SUPABASE_PUBLIC__` script | Set `assets.run_worker_first` to `true`, or to route patterns that cover your HTML                                              |
| The Worker's default export is not wrapped                                                                                                                                                                                                                                                | `curl <preview>/.well-known/supabase-preview` returns your app's 404 or HTML, not JSON                                                                                                                                                               | `export default withSupabasePreviews(handler)`                                                                                  |
| The client is created from build-time env, not `readPublicConfig()`                                                                                                                                                                                                                       | grep for `createClient(`                                                                                                                                                                                                                             | Use `readPublicConfig() ?? { ...import.meta.env fallback }`                                                                     |
| You are on an old `wrangler versions upload --preview-alias` URL, not a Worker Preview                                                                                                                                                                                                    | the hostname is an alias you made by hand                                                                                                                                                                                                            | Old preview aliases cannot be deleted and run with **production** secrets. Do not use them; point a stale one at a stub version |

## My Preview still uses an old database

**Symptom.** `check` reports `last saw <old ref>`, or the Preview keeps reading a database you replaced.

**Causes and fixes.**

- **The base config changed after the Preview was created.** A Preview copies the base config once, at creation, and redeploying does not refresh it ([Cloudflare: configuration](https://developers.cloudflare.com/workers/previews/configuration/)). This matters after `supabase-worker-previews shared` rewrites the shared branch's secret key. Delete only the Preview with `npx wrangler preview delete --name <branch> --worker-name <worker>` and push the branch again. (`supabase-worker-previews down` also deletes the branch's own Supabase database, if it has one.)
- **`previews.vars` changed but the branch has not rebuilt.** `previews.vars` is read on each Preview deploy. Merge or rebase the trunk into the branch and push.
- **A PR's `SUPABASE_OVERRIDE` points at a branch that was recreated.** Re-run the workflow, or run `npx supabase-worker-previews up --branch <b>`, which writes a fresh override.
- **The PR no longer needs its own database, but its override remains.** `supabase-worker-previews pr` removes `SUPABASE_OVERRIDE` (and the branch `up` made) on its next run on the shared path. If the label was removed, that run is triggered by `unlabeled`; a workflow written before that trigger was added needs it in `on.pull_request.types`. Look for `removed SUPABASE_OVERRIDE from Preview <name>; it serves preview again` in the log. By hand: `npx wrangler preview secret delete SUPABASE_OVERRIDE --name <preview> --worker-name <worker>`.
- **Just recreated.** After a delete and recreate, the hostname served the old version for a few seconds. Wait and re-run `check`.

## The Preview database check never passes

`check` retries every 20 seconds, 45 times, then fails with:

```text
The Preview of <branch> never served <want> (<ref>); last saw <seen>
```

| `last saw`                                     | Cause                                                                                                                                                                                                                                                                                | Fix                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `no Preview yet`                               | Workers Builds has not made a Preview for this branch                                                                                                                                                                                                                                | Check the build log in the Cloudflare dashboard. Non-production branch builds must be on, with the deploy command `npx wrangler preview` |
| `Preview <slug> exists but was never deployed` | A Preview record exists with `deployed_on: null` and answers 404 on every path, because its build never deployed. One measured cause: the build failed on wrangler's first API call with Cloudflare code 10013 ("unknown error") after Workers Builds had already created the record | Read the build log. For a 10013, retry the build (a rebuild with the same command succeeded); otherwise fix the build and push again     |
| `HTTP 404` (or another status)                 | The identity route is not served and `checkPath` does not return 200                                                                                                                                                                                                                 | Wrap the Worker, or set `checkPath` to a page that returns 200                                                                           |
| `no Supabase URL in the page`                  | No identity route, and the page at `checkPath` has no `https://<ref>.supabase.co` URL (for example, a custom API domain)                                                                                                                                                             | Wrap the Worker so the identity route answers                                                                                            |
| `several databases in the page: ...`           | The fallback page scan found more than one ref                                                                                                                                                                                                                                       | Wrap the Worker, or point `checkPath` at a page that names one database                                                                  |
| another project ref                            | The Preview serves a different database than expected                                                                                                                                                                                                                                | See [Preview still serves an old database](#my-preview-still-uses-an-old-database)                                                       |

Other errors from `check` and `up`:

- `No Supabase branch for <want> on <ref>`: for the shared case, run `npx supabase-worker-previews shared`. For a PR that needs its own database, the integration has not created the branch; check that automatic branching is on and the Supabase directory setting matches `supabaseDir`.
- `No deployed Preview <name> appeared; is a Preview being deployed for it?`: `up` waited 10 minutes for the Preview to be deployed. Same fixes as `no Preview yet`.

Workers Builds names a Preview after the raw git branch (`feat/x`), and Cloudflare derives the slug (`feat-x`). `supabase-worker-previews` matches on the raw name first, then the slug. The dashboard accepted only a literal `npx wrangler preview` as the Preview command when measured; a custom `--name` breaks the match.

If your own CI deploys Previews as `pr-<number>` (Cloudflare's automation examples do), set `"previewName": "pr"` in `supabase-worker-previews.json`. `supabase-worker-previews` then looks for `pr-<n>` instead; `supabase-worker-previews pr` takes the number from the event, and `up`, `check` and `down` need `--pr <n>` or fail with `previewName is "pr", so pass the PR number (--pr <n>)`.

## A deleted Preview still loads

**Symptom.** After `supabase-worker-previews down` or `wrangler preview delete`, the Preview URL still serves, while the Previews API no longer lists it.

**Cause.** The Preview was first created **from a laptop** (`wrangler preview` run locally). Such Previews kept serving for 15 minutes or more after deletion, by wrangler or the API. Previews created by Workers Builds returned 404 within 15 seconds of deletion.

**Fix.** Wait it out; there is no known way to force it. Create Previews by pushing a branch rather than running `wrangler preview` locally.

## Sign-in links and OAuth redirect to localhost

**Symptom.** A magic link, OAuth sign-in or password reset from a Preview lands on `http://localhost:3000` (or whatever `site_url` your `config.toml` has).

**Cause.** Supabase ignores a `redirectTo` that is not on the project's redirect allow list and uses the Site URL instead ([Supabase troubleshooting](https://supabase.com/docs/guides/troubleshooting/why-am-i-being-redirected-to-the-wrong-url-when-using-auth-redirectto-option-_vqIeO)). The GitHub integration re-applies `config.toml` to branches on **every push**, so the Site URL and redirect list that `supabase-worker-previews shared` and `supabase-worker-previews up` set through the API are replaced by `config.toml`'s values on the next push.

**Fix.**

1. Add the Preview wildcard to `supabase/config.toml` so it survives every push. `doctor` warns `additional_redirect_urls has no workers.dev entry` when it is missing:

   ```toml
   [auth]
   additional_redirect_urls = ["https://*-<worker>.<subdomain>.workers.dev/**"]
   ```

2. Pass the redirect explicitly from the browser, so the Site URL is never used:

   ```ts
   await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
   await supabase.auth.signInWithOAuth({
     provider: "github",
     options: { redirectTo: window.location.origin },
   });
   ```

## A binding or secret is undefined only in Previews

**Symptom.** `env.CACHE is undefined`, `env.RATE_LIMITER.limit is not a function`, or an app secret is missing, only in Previews.

**Causes and fixes.**

- **Previews inherit no bindings** (or `vars`) from the top-level config. Redeclare each one under `previews`. `doctor` warns `"<key>" is bound at the top level but not in "previews"; Previews do not inherit bindings` and `vars missing from previews.vars: ...`.
- **An app secret was added to the base config after the Preview was created.** The Preview kept its original copy. Delete the Preview and push again.
- **Platform limits on Previews.** Cloudflare documents that a service binding reaches only the production version of the other Worker, Previews cannot consume Queues, and Cron Triggers target production only ([Cloudflare: resources](https://developers.cloudflare.com/workers/previews/resources/)).

## `supabase-worker-previews shared` or `supabase-worker-previews up` hangs, then says the branch is not ready

**Symptom.** `supabase-worker-previews shared` or `supabase-worker-previews up` logs nothing for minutes, then fails with:

```text
Supabase branch <ref> not ready after 15 minutes: <have> of <want> migrations, <status>
```

or ends at once with `Supabase branch <ref> ended MIGRATIONS_FAILED` (or `FUNCTIONS_FAILED`).

**What `supabase-worker-previews` waits for.** A new branch 404s on `GET /v1/branches/{ref}` for several seconds, and its status reaches `FUNCTIONS_DEPLOYED` before the migrations finish. So `supabase-worker-previews` waits until `supabase_migrations.schema_migrations` holds at least as many rows as there are `.sql` files in `supabase/migrations/` in your checkout.

**Causes and fixes.**

- **A migration failed.** Open the branch in the Supabase dashboard, or the Supabase check on the PR, and read the migration log. Fix the migration and push.
- **The checkout has migrations the branch will never run.** The count compares your local files with the branch. For the shared branch, it tracks the trunk: run `supabase-worker-previews shared` from an up-to-date trunk checkout, not from a feature branch with new migrations.
- **A file in `supabase/migrations/` ends in `.sql` but is not a migration** (a scratch file). Remove it from the folder.
- **Supabase is slow.** Creation can take several minutes. Re-run the workflow; `up` reuses the existing branch.

## Cannot create Supabase branch

`supabase-worker-previews up` (and `supabase-worker-previews shared`) explain a failed `POST /v1/projects/{ref}/branches` as `Cannot create Supabase branch "<name>": <advice> Supabase said: <status> <body>`:

| Advice                                                                                | Fix                                                                                                             |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Project <ref> has reached its branch limit. ...`                                     | `npx supabase-worker-previews prune` lists leftover branches; delete them with `--yes`, or raise the limit      |
| `The organization's plan does not allow persistent branches` / `does not include ...` | Upgrade the plan (the message carries Supabase's upgrade URL when it sends one)                                 |
| `The Supabase access token is invalid or expired.`                                    | Create a new token                                                                                              |
| `The Supabase access token cannot create branches on <ref>; ...`                      | Use an organization-scoped token with branch write access ([tokens](tokens.md))                                 |
| `A Supabase branch named "<name>" already exists on <ref>.`                           | A branch with that name exists but is not tied to this git branch, so `up` did not find it; rename or delete it |
| `The Supabase API is rate limiting this token; run again in a minute.`                | Re-run the workflow                                                                                             |

`supabase-worker-previews shared` also refuses a project without branching: `Branching is not enabled on <ref>. Connect the repo in the Supabase dashboard (project settings, Integrations, GitHub, automatic branching on), then run supabase-worker-previews shared again.`

## The PR check is green but nothing happened

`supabase-worker-previews pr` exits 0 without doing anything, and says why in an annotation, in two cases:

- `::notice::supabase-worker-previews pr skipped PR #<n>: it comes from the fork <owner/repo>, and GitHub Actions gives fork PRs no secrets`. Expected; there is nothing to fix.
- `::warning::supabase-worker-previews pr skipped PR #<n>: <NAMES> are empty; ...` on a bot's PR (Dependabot gets no Actions secrets). Expected for bots.

On anyone else's PR, empty secrets fail the job with `::error::supabase-worker-previews pr cannot check PR #<n>: <NAMES> are empty; add them to the repository's Actions secrets`. Add the named secrets.

## No PR comment or View deployment button

The comment and deployment never fail the job. Look for `::warning::PR comment skipped: ...` or `::warning::GitHub deployment skipped: ...` in the log. A 403 there means the workflow lacks `pull-requests: write` or `deployments: write`; add them under `permissions:` ([tokens](tokens.md#github_token)). Neither is written in `--dry-run`, or when `prComment` / `githubDeployments` is `false` or `--no-comment` / `--no-deployments` is passed.

## The access token cannot reveal secret API keys

`Project <ref>: the access token cannot reveal secret API keys; use a token with the project's secrets permission`: the API returned the secret key masked with `·`, so the token lacks the permission to reveal it. Give it **API Key Secrets: Read** ([tokens](tokens.md#supabase-access-token)).

## `node: .env.supabase-worker-previews: not found` or exit code 9

**Symptom.** `supabase-worker-previews ... --env-file <file>` prints `node: <file>: not found` and exits 9 before `supabase-worker-previews` prints anything. When the file exists, `supabase-worker-previews` instead stops with `Unknown flag --env-file. Did you mean --dotenv?`

**Cause.** Node 24 reads `--env-file` anywhere on the command line as its own flag, so a missing file stops Node before `supabase-worker-previews` runs. `supabase-worker-previews` uses `--dotenv` for this reason.

**Fix.** Use `--dotenv <file>`, or name the file `.env.supabase-worker-previews`, which `supabase-worker-previews` loads by default.

## A token is invalid or expired

**Symptom.** A command fails with one line such as `Supabase API GET /projects/<ref>/branches: 401 JWT could not be decoded. SUPABASE_ACCESS_TOKEN is invalid or expired; see ...`. GitHub calls read `GitHub API GET <path>: 401 ...`.

**Fix.** Create a new token with the scopes in [tokens](tokens.md) and update `.env.supabase-worker-previews` or the Actions secret it names. If a variable is missing rather than wrong, `supabase-worker-previews` lists each missing one with where to get it.

## Upgrading from 0.1: `swp` is not found

Before 0.2.0 the CLI was also installed as `swp`. That name is gone, because `npx swp` on a machine without this package runs an unrelated npm package named `swp` that deletes dependency and build folders. Use `npx supabase-worker-previews <command>` in scripts and workflows.

Two files were renamed too. Both old names still work, with a warning, until you rename them:

| Before 0.2.0      | Now                                |
| ----------------- | ---------------------------------- |
| `swp.config.json` | `supabase-worker-previews.json`    |
| `.env.swp`        | `.env.supabase-worker-previews`    |
| `SWP_DEBUG=1`     | `SUPABASE_WORKER_PREVIEWS_DEBUG=1` |

## `wrangler is not installed in this project`

wrangler is started with `npx --no-install`, so it must be in your project's `node_modules`: `npm install --save-dev wrangler@latest` (4.135.0 or later). In GitHub Actions, run `npm ci` before `supabase-worker-previews pr` or the action. It is never downloaded on the fly, because that would hand your Cloudflare token to whatever version is latest at that moment.

## `prune` says the repo has no branch named after the trunk

`prune` refuses to plan when the repo it read has no branch named like `trunk` in `supabase-worker-previews.json`, because then every branch and Preview would look like a leftover. Check `--repo`, `GITHUB_REPOSITORY`, or the `origin` remote (a fork's `origin` is the usual cause), and that `trunk` is right.

## `up` refuses the trunk or a persistent branch

The trunk's Preview uses the shared Preview database, and a persistent branch is long-lived on purpose, so `up` never repoints either. Run `up` for a feature branch; use `shared` to repair the shared Preview database.

## Still stuck

Run the failing command again with `SUPABASE_WORKER_PREVIEWS_DEBUG=1` to print the stack trace, then open an [issue](https://github.com/mattruby/supabase-worker-previews/issues/new/choose) with it, the output of `npx supabase-worker-previews doctor` and the failing log. If you found a platform behaviour that disagrees with [gotchas.md](../skills/supabase-worker-previews/references/gotchas.md), say what you ran and what you saw.

---

[← Previous: Astro](frameworks/astro.md) · [Docs index](README.md) · [Next: How it works →](how-it-works.md)
