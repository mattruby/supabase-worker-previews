# React Router v7 on Cloudflare Workers

How to wrap a React Router v7 Worker and read Supabase settings so the override applies.

Framework mode. Sources: [Cloudflare: React Router](https://developers.cloudflare.com/workers/framework-guides/web-apps/react-router/). React Router's own [deploying page](https://reactrouter.com/start/framework/deploying) links to Cloudflare's template rather than documenting Workers itself. Checked 2026-09-30.

## Worker entry

In Cloudflare's template, wrangler `main` points at `./workers/app.ts`, which the guide shows as:

```ts
import { createRequestHandler } from "react-router";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
} satisfies ExportedHandler<CloudflareEnvironment>;
```

The guide also describes a generated configuration whose `main` is `build/server/index.js`. To wrap the Worker you need an entry file you own, so use the `workers/app.ts` form.

## Wrap it

```ts
import { createRequestHandler } from "react-router";
import { withSupabasePreviews } from "supabase-worker-previews";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default withSupabasePreviews({
  async fetch(request, env, ctx) {
    return requestHandler(request, { cloudflare: { env, ctx } });
  },
} satisfies ExportedHandler<CloudflareEnvironment>);
```

The `env` your `fetch` receives is already the overridden one, so the `cloudflare.env` you hand React Router carries it.

## Reading env on the server

Loaders and actions read bindings from the load context:

```ts
export function loader({ context }: Route.LoaderArgs) {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = context.cloudflare.env;
  // ...
}
```

That is the `env` from the wrapped `fetch`, so it **is** the overridden value. The guide uses `cloudflare:workers` only to import `WorkflowEntrypoint`, not for `env`. If your own code does `import { env } from "cloudflare:workers"`, it sees the raw values; read from `context.cloudflare.env`, or `process.env` under `nodejs_compat`, instead.

## Reading the config in the browser

React Router builds with Vite (the entry uses `import.meta.env.MODE`), so the dev-server fallback uses `VITE_` variables:

```ts
import { createClient } from "@supabase/supabase-js";
import { readPublicConfig } from "supabase-worker-previews";

const { supabaseUrl, supabaseKey } = readPublicConfig() ?? {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
};
export const supabase = createClient(supabaseUrl, supabaseKey);
```

Create the client in browser code only (for example in a module imported from `clientLoader` or an effect). During server rendering there is no `window.__SUPABASE_PUBLIC__`; `readPublicConfig()` returns `null` there and the fallback would read build-time values. Server code should use `context.cloudflare.env`.

**Unverified:** the Cloudflare guide does not mention `VITE_` client variables; the fallback relies on Vite's standard behaviour. Server-rendered HTML passes through the Worker, so it is injected; if you prerender routes to static assets, those pages are served without the Worker (see [`run_worker_first`](https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first)). Not checked: whether hydrating a document that React Router renders from `<html>` down reports the injected `<head>` script as a mismatch.

---

[← Previous: Hono](hono.md) · [Docs index](../README.md) · [Next: Astro →](astro.md)
