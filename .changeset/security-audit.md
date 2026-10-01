---
"supabase-worker-previews": minor
---

Security hardening from an audit:

- Previews are matched by exact name only, so a branch that shares a URL slug (`feat-x`, `Feat/X`) can no longer change or delete another PR's Preview.
- `shared` checks the branch record before writing to it, and `up` refuses the trunk and persistent branches.
- `prune` refuses a repo that has no branch named after the trunk.
- wrangler runs with `npx --no-install` and is never downloaded on the fly. The action pins its fallback version to the release and no longer sets `npm_config_yes`; the templates install with `npm ci`, pin `actions/checkout` and `setup-node` by SHA and set `persist-credentials: false`.
- The PR status comment is only ever updated when a bot wrote it, and branch names and errors can no longer break its formatting.
- Dotenv files set only the token variables, never `NODE_OPTIONS` or anything else.
- `init` never writes through a symlink.
- `SUPABASE_OVERRIDE` applies only its four values and must be a JSON object.
- The injected script reuses the page's CSP nonce, and the new `script: "json"` option emits a non-executing block for a strict CSP; `globalName` must be an identifier.
