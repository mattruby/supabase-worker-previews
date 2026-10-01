# Releasing

Releases are automated with [Changesets](https://changesets.dev) and published to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC). There is no `NPM_TOKEN` secret, and there should never be one.

## How a release happens

1. Pull requests that change the published package include a changeset (`npx changeset`, see [CONTRIBUTING.md](CONTRIBUTING.md)).
2. On every push to `main`, [`.github/workflows/release.yml`](.github/workflows/release.yml) decides what to do:
   - **Pending changesets:** the `version` job opens or updates a "Version Packages" pull request. It runs `npm run version-packages`, which bumps `package.json`, writes `CHANGELOG.md`, syncs `.claude-plugin/plugin.json` and refreshes `package-lock.json`.
   - **No changesets, and the version in `package.json` is not on npm yet** (the state right after the Version Packages PR merges): the `pack` job runs the checks and packs the tarball with no publish credentials; the `publish` job publishes that tarball with an OIDC token, then pushes the `v<version>` git tag and creates a GitHub release.
   - **Otherwise:** nothing.
3. To release, review and merge the Version Packages pull request.

The Version Packages pull request is pushed with the workflow's `GITHUB_TOKEN`, and GitHub does not start other workflows from events that token causes, so CI does not run on it by itself. If `main` requires the CI checks, close and reopen the pull request (or push an empty commit to its branch) to start them.

npm attaches a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements) to every version published this way. `publishConfig.provenance` is set as well, so a publish from somewhere that cannot produce provenance errors instead of shipping a version without it.

## One-time setup before the first release

Do these in order. Steps 1 to 3 happen on GitHub, 4 to 7 on npm.

### GitHub

1. **Create the repository** `mattruby/supabase-worker-previews` as **public** (npm cannot generate provenance from a private repository) and push `main`. `repository.url` in `package.json` must match it exactly, or trusted publishing refuses the upload.
2. **Settings, Actions, General:**
   - Workflow permissions: leave the default "Read repository contents" (each job asks for what it needs).
   - Tick **"Allow GitHub Actions to create and approve pull requests"**. Without it the `version` job fails with `GitHub Actions is not permitted to create or approve pull requests`.
3. **Settings, Environments, New environment** named exactly **`npm-publish`**. Optionally add yourself as a required reviewer so every publish waits for a click, and limit it to the `main` branch under "Deployment branches and tags". (GitHub creates the environment on first use if you skip this, but without any protection rules.)

Also worth turning on, though releases do not depend on them:

- **Settings, Code security:** Private vulnerability reporting (SECURITY.md points reporters there), Dependabot alerts and security updates.
- **Settings, General, Features:** Discussions (the issue template config sends questions there).
- **Settings, Rules:** a ruleset for `main` requiring the CI checks (`Node 22`, `Node 24`, `Node 26`, `Node 22.0.0 (engines floor)`), and a tag ruleset restricting who can create `v*` tags.

### npm

Trusted publishing can only be configured on a package that already exists on the registry (`npm help trust`: "The package you're configuring must already exist"). So the name is claimed with a throwaway placeholder first, and the real `0.1.0` comes from CI with provenance.

4. **Turn on 2FA** for your npm account if it is not on (`npm trust` requires it), then `npm login`. Use npm 11.5.1 or later locally (`npm --version`; Node 24 ships a new enough npm).
5. **Claim the name** with a placeholder version, published from an empty directory, not from this repo:

   ```sh
   mkdir /tmp/swp-placeholder && cd /tmp/swp-placeholder
   npm init -y >/dev/null
   npm pkg set name=supabase-worker-previews version=0.0.0 license=MIT \
     description="Placeholder. Install 0.1.0 or later." \
     repository.type=git repository.url=git+https://github.com/mattruby/supabase-worker-previews.git
   npm publish --access public
   ```

6. **Configure the trusted publisher.** Either on the website (npmjs.com, Packages, supabase-worker-previews, Settings, Trusted publishing, GitHub Actions):

   | Field                | Value                                           |
   | -------------------- | ----------------------------------------------- |
   | Organization or user | `mattruby`                                      |
   | Repository           | `supabase-worker-previews`                      |
   | Workflow filename    | `release.yml` (the filename only, not the path) |
   | Environment name     | `npm-publish`                                   |
   | Allowed actions      | tick **`npm publish`** (see below)              |

   or from the CLI:

   ```sh
   npm trust github supabase-worker-previews --repo mattruby/supabase-worker-previews \
     --file release.yml --env npm-publish
   npm trust list supabase-worker-previews
   ```

   **Allowed actions matters.** Trusted publishers created after 2026-09-03 allow only `npm stage publish` by default; direct `npm publish` must be ticked explicitly. Changesets does not support staged publishing yet, so without the tick the first release fails with an authorization error. If you used the CLI, check the publisher's allowed actions on the website afterwards. npm does not validate any of these fields when you save them; a typo only shows up as `ENEEDAUTH` / 404 at publish time.

7. **Lock the package down** (Settings, Publishing access): select **"Require two-factor authentication and disallow tokens"**. Trusted publishing keeps working; any leaked token stops working. Revoke any automation or granular tokens you created for this package.

### First release

8. Merge the release-engineering work to `main`. `package.json` already says `0.1.0` and there are no pending changesets, so the release workflow goes straight to `pack` and `publish` (waiting for approval if you added a reviewer to `npm-publish`).
9. Check the result: `npm view supabase-worker-previews@0.1.0` shows the version, the npm page shows the provenance badge linking to the workflow run, and GitHub has a `v0.1.0` tag and release.
10. Retire the placeholder: `npm deprecate supabase-worker-previews@0.0.0 "Placeholder; use 0.1.0 or later"`.

## Troubleshooting

- **`ENEEDAUTH` or 404 on publish:** the trusted publisher fields do not match the run. Compare owner, repo, `release.yml`, and environment `npm-publish` exactly (case-sensitive), and confirm "npm publish" is an allowed action.
- **Provenance error about the repository:** `repository.url` in `package.json` must be `git+https://github.com/mattruby/supabase-worker-previews.git`, and the repository must be public.
- **"npm 11.5.1 or later" step fails:** the runner's Node 24 shipped an older npm; add `npm install -g npm@11` before it.
- **A release needs to be redone:** npm versions are immutable. Fix forward with a new changeset; `npm deprecate` the bad version if users should avoid it.
