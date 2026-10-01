# Compared with Vercel

How `supabase-worker-previews` on Cloudflare compares with Vercel and Supabase's Vercel integration, to help you pick one.

Vercel plus Supabase's Vercel integration is the setup `supabase-worker-previews` imitates. Both rely on the same Supabase branching underneath, so database behaviour (migrations, `seed.sql`, `config.toml`, per-hour branch billing) is the same. What differs is how each preview learns its database. Vendor behaviour below is from the cited docs, checked 2026-09-30.

## What Vercel and the Supabase integration give you

- **A preview per push and per PR**, with a branch URL that always points at the latest commit and a commit URL ([Vercel: environments](https://vercel.com/docs/deployments/environments)), announced in a PR comment ([Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github)).
- **Deployment protection** for previews: Vercel describes Standard Protection, which "Protects all deployments except production domains", as "the recommended option for most projects" ([Vercel: deployment protection](https://vercel.com/docs/deployment-protection)).
- **Per-branch Supabase credentials.** "Supabase automatically updates your Vercel project with the correct environment variables for the corresponding preview branches. The synchronization happens at the time of Pull Request being opened" ([Supabase: branching integrations](https://supabase.com/docs/guides/deployment/branching/integrations)). It needs both the Supabase GitHub integration and Vercel's.
- **Automatic redeploys.** Vercel bakes environment variables into each deployment ("Any change you make to environment variables are not applied to previous deployments", [Vercel: environment variables](https://vercel.com/docs/environment-variables)), so Supabase redeploys the PR's latest deployment once the variables are set, to cover the race between the two.
- **A first-party, supported integration.** Nothing to install in the repo, no workflow, no tokens to manage.

Gaps, as documented:

- Supabase's docs do not say which database a Preview gets when its branch has **no** Supabase branch (for example, with "Supabase changes only" on). Vercel's rule is that branch-specific variables override the general Preview ones, so such a branch gets whatever the general Preview variables are, which may be production.
- Custom Supabase domains are not supported; the integration always uses the base `SUPABASE_URL` ([Supabase: Vercel Marketplace](https://supabase.com/docs/guides/integrations/vercel-marketplace)).
- Nothing checks which database a preview actually serves.

## What `supabase-worker-previews` gives you on Cloudflare

- **Worker Previews per branch**, built by Workers Builds. Cloudflare provides the builds and URLs; `supabase-worker-previews` adds nothing there.
- **An explicit shared Preview database** for every branch without its own: a persistent Supabase branch that tracks the trunk. A Preview never falls back to production by default, and `doctor` fails if `previews.vars` names production.
- **Its own database for each PR that changes `supabase/`**, or carries the `isolated-db` label, made by the same Supabase GitHub integration.
- **No rebuilds to switch database.** The Worker reads its Supabase settings per request and injects the public ones into HTML, so pointing a Preview at a new database is one secret write, not a new build.
- **A check that confirms it.** `supabase-worker-previews check` reads which database each Preview serves and fails a PR the moment one serves production.

Costs: a GitHub workflow and three secrets in your repo, a `previews` block to keep in step with your bindings, a wrapper around the Worker, and the caveat that code reading `env` from `cloudflare:workers` does not see the override. Worker Previews [launched on 2026-09-22](https://developers.cloudflare.com/changelog/post/2026-09-22-worker-previews/) and `supabase-worker-previews` is 0.x.

On the PR, `supabase-worker-previews pr` keeps one status comment (Preview link, database, pass or fail) and records a GitHub deployment, which gives the PR a "View deployment" button.

## Pick Vercel instead when

- you are already on Vercel, or your framework is Next.js and you want its first-party hosting;
- you want a vendor-supported integration rather than a beta CLI and a workflow you own;
- you need preview access control without configuring it yourself;
- every branch you care about changes the schema, so the undocumented no-branch fallback never matters.

## Pick `supabase-worker-previews` when

- the app already runs on Cloudflare Workers, or needs Workers bindings (KV, D1, R2, Durable Objects, Queues);
- you want every Preview on a known non-production database, with CI that fails if it is not;
- you want one build to serve any database.

---

[← Previous: Security](security.md) · [Docs index](README.md)
