# Astro on Cloudflare Workers

Astro 6 with `@astrojs/cloudflare` v13 or later. Sources: [Astro: @astrojs/cloudflare](https://docs.astro.build/en/guides/integrations-guide/cloudflare/) (v14.3.3 at the time of writing), [Astro: environment variables](https://docs.astro.build/en/guides/environment-variables/). Cloudflare's own [Astro guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/) still describes the Astro 5 setup (`"main": "./dist/_worker.js/index.js"`, bindings in `locals`), so follow Astro's adapter docs. Checked 2026-09-30.

## Worker entry

The adapter's default `main` is a package entry:

```jsonc
"main": "@astrojs/cloudflare/entrypoints/server",
```

For a custom entry, the adapter docs set `"main": "./src/worker.ts"` and export a handler that calls `handle`:

```ts
import { handle } from "@astrojs/cloudflare/handler";

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

The `workerEntryPoint` adapter option and `createExports()` from Astro 5 were removed in adapter v13.

## Wrap it

`src/worker.ts`, with `"main": "./src/worker.ts"`:

```ts
import { handle } from "@astrojs/cloudflare/handler";
import { withSupabasePreviews } from "supabase-worker-previews";

export default withSupabasePreviews({
  async fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>);
```

## Reading env on the server

In Astro 6, `Astro.locals.runtime` is gone and the adapter docs read bindings with:

```astro
---
import { env } from 'cloudflare:workers';
const myVariable = env.MY_VARIABLE;
---
```

or through `astro:env/server`. `cloudflare:workers` gives the **raw** values: on an isolated PR, `env.SUPABASE_URL` is still the shared Preview database. Read Supabase settings from `process.env` instead. With `nodejs_compat` and a compatibility date on or after 2025-04-01, Cloudflare populates `process.env` from vars and secrets ([Cloudflare: process](https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/)), and the wrapper writes the override over it at the start of each request:

```astro
---
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!);
---
```

Read inside the page or endpoint, not at module scope, which runs before the first request.

**Unverified:** whether the `env` you pass to `handle(request, env, ctx)` feeds `astro:env/server` or anything else page code can read. The adapter docs do not say, so do not rely on it.

## Reading the config in the browser

Astro exposes only `PUBLIC_`-prefixed variables to client code, not `VITE_` ones, so the dev-server fallback uses `PUBLIC_` names:

```ts
import { createClient } from "@supabase/supabase-js";
import { readPublicConfig } from "supabase-worker-previews";

const { supabaseUrl, supabaseKey } = readPublicConfig() ?? {
  supabaseUrl: import.meta.env.PUBLIC_SUPABASE_URL,
  supabaseKey: import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY,
};
export const supabase = createClient(supabaseUrl, supabaseKey);
```

Use it in a client `<script>` or an island, not in frontmatter (frontmatter runs on the server, where `readPublicConfig()` returns `null`).

## Prerendered pages

Astro prerenders pages by default unless they opt into on-demand rendering. Prerendered pages are static assets, served without invoking the Worker unless [`run_worker_first`](https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first) covers them, so they get no injected config and their client code falls back to build-time `PUBLIC_` values. Either render pages that create a Supabase client on demand, or route them through the Worker with `run_worker_first`.
