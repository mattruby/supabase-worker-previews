# Contributing

Thanks for helping. Bug reports, platform findings and pull requests are all welcome.

## Development setup

You need Node 22.13 or later for development (the lint and test tools need it; the published package itself supports Node 22.0 and later) and npm. `.nvmrc` pins the version CI uses for releases.

```sh
git clone https://github.com/mattruby/supabase-worker-previews.git
cd supabase-worker-previews
npm install        # also builds dist/ through the prepare script
```

| Command                | What it does                                                         |
| ---------------------- | -------------------------------------------------------------------- |
| `npm test`             | Unit tests (Vitest)                                                  |
| `npm run typecheck`    | `tsc --noEmit` over `src/` and `test/`                               |
| `npm run lint`         | ESLint with typescript-eslint's type-checked rules                   |
| `npm run format:check` | Prettier, as CI runs it (`npm run format` to fix)                    |
| `npm run build`        | Compiles `src/` to `dist/`                                           |
| `npm run test:package` | Packs the tarball, installs it in a temp project, runs `swp` from it |

CI runs all of these on Node 22, 24 and 26, plus the packaging check on Node 22.0.0, the oldest version `engines` allows. Run them locally before opening a pull request.

To typecheck the example after changing the runtime API, run `npm install` here first (it builds `dist/`, which the example links to), then `cd examples/hono-notes && npm install && npm run typecheck`. The example is not part of the published package or the root lint and typecheck.

To try a local build in a real Worker project, `npm pack` here and `npm install /path/to/supabase-worker-previews-<version>.tgz` there.

## Tests

- Tests live in `test/` and never call the real Supabase, Cloudflare or GitHub APIs; they use fakes of the API classes. Keep it that way, so the suite stays fast and needs no credentials.
- A bug fix comes with a test that fails without the fix. Check that it does: revert the fix, watch the test fail, restore.

## Platform behaviour needs a measurement

Most of this project encodes how Supabase branching, Workers Previews and wrangler actually behave, and those platforms change. Any claim about platform behaviour, in code, comments, docs or a pull request, needs a measurement behind it:

- Say what you ran (the command, API call or dashboard action), against which versions (wrangler, Supabase CLI, Node), and what you observed.
- A claim that something changed ("since wrangler 4.x", "a regression", "no longer needed") compares two states, so measure both.
- If you could not measure it, say so and call it a hypothesis. Pull requests that state unmeasured platform behaviour as fact will be asked for the measurement.

Put the measurement in the pull request description; keep code comments short.

## Changesets

Pull requests that change what users get (the CLI, the runtime entry, the templates) include a changeset:

```sh
npx changeset
```

Choose patch for fixes and minor for features (the package is 0.x), and write the summary for users. Tests, CI and docs alone need no changeset. Maintainers release by merging the "Version Packages" pull request; see [RELEASING.md](RELEASING.md).

## Pull requests

- Keep each pull request to one change, and describe what changed, why, and how you verified it.
- Do not reformat files you did not otherwise change.
- By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
