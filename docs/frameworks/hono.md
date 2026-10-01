# Hono on Cloudflare Workers

Sources: [Cloudflare: Hono](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/), [Hono: Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers). Checked 2026-09-30.

## Worker entry

The wrangler `main` points at your Hono app file (`src/index.ts` in Hono's starter, `src/worker/index.ts` in Cloudflare's Vite + React template). Hono documents two export forms: `export default app`, and an object for extra handlers:

```ts
export default {
  fetch: app.fetch,
  scheduled: async (batch, env) => {},
};
```

## Wrap it

Use the object form:

```ts
import { createClient } from "@supabase/supabase-js";
import { Hono } from "hono";
import { withSupabasePreviews } from "supabase-worker-previews";

type Bindings = {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/notes", async (c) => {
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_PUBLISHABLE_KEY);
  // ...
});

export default withSupabasePreviews({ fetch: app.fetch });
```

Add `scheduled`, `queue` or other handlers to the same object; the wrapper hands each of them the overridden `env`.

## Reading env on the server

Hono passes the Worker's `env` argument to handlers as `c.env`, so `c.env.SUPABASE_URL` **is** the overridden value. This is the documented way to read bindings in Hono; neither guide uses `cloudflare:workers`.

If any module does `import { env } from "cloudflare:workers"`, it sees the raw values (the shared Preview database even on an isolated PR). Read from `c.env`, or from `process.env` under `nodejs_compat`, where the wrapper also writes the override on each request.

## Reading the config in the browser

The Cloudflare template's frontend is a Vite React SPA, so the dev-server fallback uses `VITE_` variables:

```ts
import { createClient } from "@supabase/supabase-js";
import { readPublicConfig } from "supabase-worker-previews";

const { supabaseUrl, supabaseKey } = readPublicConfig() ?? {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
};
export const supabase = createClient(supabaseUrl, supabaseKey);
```

## Make the HTML reach the Worker

The Cloudflare template sets `assets.not_found_handling` to `single-page-application`, and its guide notes that "routes that are handled by your SPA do not go to the Worker". The injection happens in the Worker, so `index.html` served straight from assets gets no config, and the browser silently falls back to build-time values. Set [`run_worker_first`](https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first) so HTML routes go through the Worker, for example:

```jsonc
"assets": {
  "binding": "ASSETS",
  "not_found_handling": "single-page-application",
  "run_worker_first": ["/*", "!/assets/*"],
},
```

and let Hono pass anything it does not route to the assets binding, after your API routes:

```ts
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));
```

(add `ASSETS: Fetcher` to `Bindings`). The wrapper then injects the config into the HTML that comes back.

**Unverified:** neither guide shows this combination, so it is a sketch rather than a tested recipe; the route patterns are illustrative, so adjust them to your asset paths. Whether a Preview needs `assets` redeclared under `previews` is not documented on the pages checked.
