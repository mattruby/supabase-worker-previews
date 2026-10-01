# Troubleshooting

Start every investigation with:

```bash
npx swp doctor                       # local files, plus the shared branch when SUPABASE_ACCESS_TOKEN is set
npx swp check --branch <git branch>  # which database the Preview serves right now
```

Then confirm with a real browser: open the Preview, sign in, and load a page that reads data. A deploy that exits 0 and a check that passes tell you which database the page names, not that signed-in reads work.

The platform behaviour cited below was measured and is recorded in [gotchas.md](../skills/supabase-worker-previews/references/gotchas.md).

## Preview 403s on signed-in reads

**Symptom.** The Preview loads and sign-in works, but reads return 403 or `permission denied for table ...`. Production is fine.

**Cause.** The branch database's tables have only owner privileges. Supabase branches, and newer projects, start without default privileges for the `anon`, `authenticated` and `service_role` roles, so tables created by your migrations are not readable through the API. Two ways to get there:

- The branch was created through the Management API while the project was **not** linked to GitHub. Supabase then copies the parent's schema **without privileges** and ignores `git_branch`.
- The grants migration is missing, or is not the first migration, so tables were created before it ran.

**Fix.**

1. `npx swp doctor`. If it reports `the first migration (...) does not grant default privileges; branch databases will 403`, run `npx swp init`, which writes the grants migration dated before your first one, and apply it to production as `init` instructs.
2. Make sure the Supabase GitHub integration is connected (Project Settings, Integrations, GitHub) before any branch is created. With `SUPABASE_ACCESS_TOKEN` set, `doctor` checks this:
   - `branching is not enabled on <ref> (connect the Supabase GitHub integration)` when the project has no default branch.
   - `✓ Supabase builds "<branch>" from GitHub <owner>/<repo>, so branches run the repo's migrations` when it finds proof of the connection.
   - `! cannot confirm the Supabase GitHub integration: ...` when it finds none.

   The Management API has no field for whether a project is connected to GitHub. `doctor` instead reads the action runs (`GET /v1/projects/{branch ref}/actions`) of up to five branches, the shared branch first, and looks for a run that carries `git_config` with the repo, which only integration-made runs have. It cannot know about branches past those five, or whether a particular older branch was created before the repo was connected, and a branch that has had no integration run yet (for example, connected but never pushed since) gives no proof either way. If you have connected the repo and still get the warning, push to the trunk and run `doctor` again.

3. Rebuild the broken branch so it runs the migrations from scratch:
   - **A PR's branch:** close and reopen the PR. The integration deletes the branch on close and creates it again on reopen. Closing also runs `swp down`, which deletes the Preview, so push a commit afterwards to have Workers Builds recreate it.
   - **The shared `preview` branch:** persistent branches refuse `DELETE`, so first `PATCH /v1/branches/{ref}` with `{"persistent": false}`, then delete it, then run `npx swp shared` again and paste the new `previews.vars`.

## Preview shows production data

**Symptom.** A Preview reads or writes production rows.

`swp check` would fail at once with `Preview <slug> serves the production database <ref>; refusing to pass` if the page named production. If the check is green but the browser still talks to production, the browser is not using the injected config.

**Causes and fixes.**

| Cause                                                                                                                                                                                                                                                                                     | How to tell                                                                                                                                                                                                                                          | Fix                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `previews.vars` names production                                                                                                                                                                                                                                                          | `doctor`: `previews.vars points at the production project <ref>`                                                                                                                                                                                     | Run `npx swp shared` and paste its output into `previews.vars`                                                                  |
| `previews.vars` is empty, so the Worker has no `SUPABASE_URL` and injects nothing, and the browser falls back to build-time `VITE_*` values that point at production                                                                                                                      | `doctor`: `previews.vars needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY`; in the browser, `window.__SUPABASE_PUBLIC__` is undefined                                                                                                                 | Fill `previews.vars`. Keep production values out of the build environment Preview builds see                                    |
| The HTML never passes through the Worker. With [static assets](https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first), a request that matches an asset (such as an SPA's `index.html`) is served without invoking the Worker unless `run_worker_first` is set | `doctor` warns `<dir> has <files>.html; Cloudflare serves matching assets without running the Worker, ...` when the assets directory holds HTML and `run_worker_first` is unset; `view-source:` on the Preview shows no `__SUPABASE_PUBLIC__` script | Set `assets.run_worker_first` to `true`, or to route patterns that cover your HTML                                              |
| The Worker's default export is not wrapped                                                                                                                                                                                                                                                | `curl <preview>/.well-known/supabase-preview` returns your app's 404 or HTML, not JSON                                                                                                                                                               | `export default withSupabasePreviews(handler)`                                                                                  |
| The client is created from build-time env, not `readPublicConfig()`                                                                                                                                                                                                                       | grep for `createClient(`                                                                                                                                                                                                                             | Use `readPublicConfig() ?? { ...import.meta.env fallback }`                                                                     |
| You are on an old `wrangler versions upload --preview-alias` URL, not a Worker Preview                                                                                                                                                                                                    | the hostname is an alias you made by hand                                                                                                                                                                                                            | Old preview aliases cannot be deleted and run with **production** secrets. Do not use them; point a stale one at a stub version |

## Preview still serves an old database

**Symptom.** `check` reports `last saw <old ref>`, or the Preview keeps reading a database you replaced.

**Causes and fixes.**

- **The base config changed after the Preview was created.** A Preview copies the base config once, at creation, and redeploying does not refresh it ([Cloudflare: configuration](https://developers.cloudflare.com/workers/previews/configuration/)). This matters after `swp shared` rewrites the shared branch's secret key. Delete only the Preview with `npx wrangler preview delete --name <branch> --worker-name <worker>` and push the branch again. (`swp down` also deletes the branch's own Supabase database, if it has one.)
- **`previews.vars` changed but the branch has not rebuilt.** `previews.vars` is read on each Preview deploy. Merge or rebase the trunk into the branch and push.
- **A PR's `SUPABASE_OVERRIDE` points at a branch that was recreated.** Re-run the workflow, or run `npx swp up --branch <b>`, which writes a fresh override.
- **The PR no longer needs its own database, but its override remains.** `swp pr` removes `SUPABASE_OVERRIDE` (and the branch `up` made) on its next run on the shared path. If the label was removed, that run is triggered by `unlabeled`; a workflow written before that trigger was added needs it in `on.pull_request.types`. Look for `removed SUPABASE_OVERRIDE from Preview <name>; it serves preview again` in the log. By hand: `npx wrangler preview secret delete SUPABASE_OVERRIDE --name <preview> --worker-name <worker>`.
- **Just recreated.** After a delete and recreate, the hostname served the old version for a few seconds. Wait and re-run `check`.

## Check never passes, or "never deployed"

`check` retries every 20 seconds, 45 times, then fails with:

```
The Preview of <branch> never served <want> (<ref>); last saw <seen>
```

| `last saw`                                     | Cause                                                                                                                                                                                                                                                                                | Fix                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `no Preview yet`                               | Workers Builds has not made a Preview for this branch                                                                                                                                                                                                                                | Check the build log in the Cloudflare dashboard. Non-production branch builds must be on, with the deploy command `npx wrangler preview` |
| `Preview <slug> exists but was never deployed` | A Preview record exists with `deployed_on: null` and answers 404 on every path, because its build never deployed. One measured cause: the build failed on wrangler's first API call with Cloudflare code 10013 ("unknown error") after Workers Builds had already created the record | Read the build log. For a 10013, retry the build (a rebuild with the same command succeeded); otherwise fix the build and push again     |
| `HTTP 404` (or another status)                 | The identity route is not served and `checkPath` does not return 200                                                                                                                                                                                                                 | Wrap the Worker, or set `checkPath` to a page that returns 200                                                                           |
| `no Supabase URL in the page`                  | No identity route, and the page at `checkPath` has no `https://<ref>.supabase.co` URL (for example, a custom API domain)                                                                                                                                                             | Wrap the Worker so the identity route answers                                                                                            |
| `several databases in the page: ...`           | The fallback page scan found more than one ref                                                                                                                                                                                                                                       | Wrap the Worker, or point `checkPath` at a page that names one database                                                                  |
| another project ref                            | The Preview serves a different database than expected                                                                                                                                                                                                                                | See [Preview still serves an old database](#preview-still-serves-an-old-database)                                                        |

Other errors from `check` and `up`:

- `No Supabase branch for <want> on <ref>`: for the shared case, run `npx swp shared`. For an isolated PR, the integration has not created the branch; check that automatic branching is on and the Supabase directory setting matches `supabaseDir`.
- `No Preview <name> appeared; is a Preview being deployed for it?`: `up` waited 10 minutes for the Preview. Same fixes as `no Preview yet`.

Workers Builds names a Preview after the raw git branch (`feat/x`), and Cloudflare derives the slug (`feat-x`). `swp` matches on the raw name first, then the slug. The dashboard accepted only a literal `npx wrangler preview` as the Preview command when measured; a custom `--name` breaks the match.

If your own CI deploys Previews as `pr-<number>` (Cloudflare's automation examples do), set `"previewName": "pr"` in `swp.config.json`. `swp` then looks for `pr-<n>` instead; `swp pr` takes the number from the event, and `up`, `check` and `down` need `--pr <n>` or fail with `previewName is "pr", so pass the PR number (--pr <n>)`.

## A deleted Preview still loads

**Symptom.** After `swp down` or `wrangler preview delete`, the Preview URL still serves, while the Previews API no longer lists it.

**Cause.** The Preview was first created **from a laptop** (`wrangler preview` run locally). Such Previews kept serving for 15 minutes or more after deletion, by wrangler or the API. Previews created by Workers Builds returned 404 within 15 seconds of deletion.

**Fix.** Wait it out; there is no known way to force it. Create Previews by pushing a branch rather than running `wrangler preview` locally.

## Auth redirect goes to localhost

**Symptom.** A magic link, OAuth sign-in or password reset from a Preview lands on `http://localhost:3000` (or whatever `site_url` your `config.toml` has).

**Cause.** Supabase ignores a `redirectTo` that is not on the project's redirect allow list and uses the Site URL instead ([Supabase troubleshooting](https://supabase.com/docs/guides/troubleshooting/why-am-i-being-redirected-to-the-wrong-url-when-using-auth-redirectto-option-_vqIeO)). The GitHub integration re-applies `config.toml` to branches on **every push**, so the Site URL and redirect list that `swp shared` and `swp up` set through the API are replaced by `config.toml`'s values on the next push.

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

## A binding is missing in the Preview

**Symptom.** `env.CACHE is undefined`, `env.RATE_LIMITER.limit is not a function`, or an app secret is missing, only in Previews.

**Causes and fixes.**

- **Previews inherit no bindings** (or `vars`) from the top-level config. Redeclare each one under `previews`. `doctor` warns `"<key>" is bound at the top level but not in "previews"; Previews do not inherit bindings` and `vars missing from previews.vars: ...`.
- **An app secret was added to the base config after the Preview was created.** The Preview kept its original copy. Delete the Preview and push again.
- **Platform limits on Previews.** Cloudflare documents that a service binding reaches only the production version of the other Worker, Previews cannot consume Queues, and Cron Triggers target production only ([Cloudflare: resources](https://developers.cloudflare.com/workers/previews/resources/)).

## Branch stuck creating

**Symptom.** `swp shared` or `swp up` logs nothing for minutes, then fails with:

```
Supabase branch <ref> not ready after 15 minutes: <have> of <want> migrations, <status>
```

or ends at once with `Supabase branch <ref> ended MIGRATIONS_FAILED` (or `FUNCTIONS_FAILED`).

**What `swp` waits for.** A new branch 404s on `GET /v1/branches/{ref}` for several seconds, and its status reaches `FUNCTIONS_DEPLOYED` before the migrations finish. So `swp` waits until `supabase_migrations.schema_migrations` holds at least as many rows as there are `.sql` files in `supabase/migrations/` in your checkout.

**Causes and fixes.**

- **A migration failed.** Open the branch in the Supabase dashboard, or the Supabase check on the PR, and read the migration log. Fix the migration and push.
- **The checkout has migrations the branch will never run.** The count compares your local files with the branch. For the shared branch, it tracks the trunk: run `swp shared` from an up-to-date trunk checkout, not from a feature branch with new migrations.
- **A file in `supabase/migrations/` ends in `.sql` but is not a migration** (a scratch file). Remove it from the folder.
- **Supabase is slow.** Creation can take several minutes. Re-run the workflow; `up` reuses the existing branch.

## Branch cannot be created

`swp up` (and `swp shared`) explain a failed `POST /v1/projects/{ref}/branches` as `Cannot create Supabase branch "<name>": <advice> Supabase said: <status> <body>`:

| Advice                                                                                | Fix                                                                                                             |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Project <ref> has reached its branch limit. ...`                                     | `npx swp prune` lists leftover branches; delete them with `--yes`, or raise the limit                           |
| `The organization's plan does not allow persistent branches` / `does not include ...` | Upgrade the plan (the message carries Supabase's upgrade URL when it sends one)                                 |
| `The Supabase access token is invalid or expired.`                                    | Create a new token                                                                                              |
| `The Supabase access token cannot create branches on <ref>; ...`                      | Use an organization-scoped token with branch write access ([tokens](tokens.md))                                 |
| `A Supabase branch named "<name>" already exists on <ref>.`                           | A branch with that name exists but is not tied to this git branch, so `up` did not find it; rename or delete it |
| `The Supabase API is rate limiting this token; run again in a minute.`                | Re-run the workflow                                                                                             |

`swp shared` also refuses a project without branching: `Branching is not enabled on <ref>. Connect the repo in the Supabase dashboard (project settings, Integrations, GitHub, automatic branching on), then run swp shared again.`

## The PR check is green but nothing happened

`swp pr` exits 0 without doing anything, and says why in an annotation, in two cases:

- `::notice::swp pr skipped PR #<n>: it comes from the fork <owner/repo>, and GitHub Actions gives fork PRs no secrets`. Expected; there is nothing to fix.
- `::warning::swp pr skipped PR #<n>: <NAMES> are empty; ...` on a bot's PR (Dependabot gets no Actions secrets). Expected for bots.

On anyone else's PR, empty secrets fail the job with `::error::swp pr cannot check PR #<n>: <NAMES> are empty; add them to the repository's Actions secrets`. Add the named secrets.

## No PR comment or deployment

The comment and deployment never fail the job. Look for `::warning::PR comment skipped: ...` or `::warning::GitHub deployment skipped: ...` in the log. A 403 there means the workflow lacks `pull-requests: write` or `deployments: write`; add them under `permissions:` ([tokens](tokens.md#github_token)). Neither is written in `--dry-run`, or when `prComment` / `githubDeployments` is `false` or `--no-comment` / `--no-deployments` is passed.

## Secret API keys are masked

`Project <ref>: the access token cannot reveal secret API keys; use a token with the project's secrets permission`: the API returned the secret key masked with `·`, so the token lacks the permission to reveal it. Give it **API Key Secrets: Read** ([tokens](tokens.md#supabase-access-token)).
