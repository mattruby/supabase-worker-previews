# TanStack Start on Cloudflare Workers

How to wrap a TanStack Start Worker and read Supabase settings so the override applies. This is the framework where reading `env` correctly matters most.

Sources: [Cloudflare: TanStack Start](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/), [TanStack: hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting), [TanStack: server entry point](https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point), [TanStack: environment variables](https://tanstack.com/start/latest/docs/framework/react/guide/environment-variables). Checked 2026-09-30.

## Worker entry

By default the wrangler `main` is the package entry, not a file in your project:

```jsonc
"main": "@tanstack/react-start/server-entry",
```

To wrap it, add your own entry. Cloudflare's guide shows `src/server.ts` with `"main": "src/server.ts"`, exporting `fetch: handler.fetch` alongside other handlers. TanStack's server-entry doc shows:

```tsx
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

export default createServerEntry({
  fetch(request) {
    return handler.fetch(request);
  },
});
```

## Wrap it

`src/server.ts`, with `"main": "src/server.ts"` in the wrangler config:

```ts
import handler from "@tanstack/react-start/server-entry";
import { withSupabasePreviews } from "supabase-worker-previews";

export default withSupabasePreviews({
  fetch(request: Request) {
    return handler.fetch(request);
  },
});
```

Call `handler.fetch(request)` from your own function rather than passing `handler.fetch` directly: its second parameter is TanStack's request options, and the wrapper calls `fetch(request, env, ctx)`.

If your build runs the app through Nitro, Nitro calls the entry's `fetch(request)` without `env` ([measured](../../skills/supabase-worker-previews/references/gotchas.md#cloudflare-worker-previews)). The wrapper then uses `process.env` as the env (vars and secrets are there under `nodejs_compat`), so the override, the injection and the identity route still work.

## Reading env on the server

This is the framework where the caveat bites. TanStack's environment-variables guide calls the `cloudflare:workers` env binding the canonical way to read env from anywhere, including module scope, and Cloudflare's guide uses `import { env } from "cloudflare:workers"` throughout. `handler.fetch` does not receive the Worker's `env` at all. So:

- `import { env } from "cloudflare:workers"` gives the **raw** values. On a PR with its own database, `env.SUPABASE_URL` is still the shared Preview database.
- `process.env.SUPABASE_URL` gives the **overridden** value, inside a request. With `nodejs_compat` and a compatibility date on or after 2025-04-01, Cloudflare populates `process.env` from vars and secrets ([Cloudflare: process](https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/)), and the wrapper writes the override over it at the start of each request.

Read Supabase settings from `process.env` in server functions:

```ts
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";

const getNotes = createServerFn().handler(async () => {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  // ...
});
```

Do not read them at module scope: module code runs before the first request, before the override is applied. Cloudflare notes that writes to `process.env` persist for the isolate, which is what makes the override visible to later code in the same request; every request in a Preview carries the same override, so this does not leak between databases.

Other bindings (KV, D1, R2) are unaffected by the override, so reading those from `cloudflare:workers` is fine.

## Reading the config in the browser

TanStack Start builds with Vite and exposes `VITE_`-prefixed variables on `import.meta.env` (Rsbuild projects use `PUBLIC_`):

```ts
import { createClient } from "@supabase/supabase-js";
import { readPublicConfig } from "supabase-worker-previews";

const { supabaseUrl, supabaseKey } = readPublicConfig() ?? {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
};
export const supabase = createClient(supabaseUrl, supabaseKey);
```

Create this client only in browser code. During server rendering `readPublicConfig()` returns `null` and the fallback would read build-time values.

**Unverified:** whether hydrating a document that TanStack Start renders from `<html>` down reports the injected `<head>` script as a mismatch. Prerendered routes are static assets and are served without the Worker unless [`run_worker_first`](https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first) covers them, so they get no injected config.

---

[← Previous: Quickstart](../quickstart.md) · [Docs index](../README.md) · [Next: Hono →](hono.md)
