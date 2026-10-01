---
"supabase-worker-previews": minor
---

The CLI is easier to pick up: grouped `swp --help` with per-command help (`swp <command> --help`), `swp --version`, "did you mean" for mistyped commands, flags and `swp.config.json` keys, and a usage error (exit 2) for unknown flags, stray arguments or a flag missing its value. `swp doctor` groups its checks into local and online, says what to do after every warning and error, and ends with a summary; it now runs its local checks even when the config is broken. `swp init` takes `--dry-run` and `--action` (a workflow using the published action), and its next steps link the quickstart. Missing tokens are all named at once with where to get each, and API errors are one line with the status and, for a 401 or 403, the token to check.
