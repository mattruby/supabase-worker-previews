# Documentation

Everything about `swp`, in the order you are likely to need it. Start at the top if you are new; jump to Reference when you know what you are looking for.

## Learn

1. [Concepts](concepts.md): Worker Previews, Supabase branches, the shared Preview database, request-time config and the identity route.
2. [Quickstart](quickstart.md): from an existing Worker and Supabase project to the first PR whose Preview runs on the right database.
3. [Example: Hono notes](../examples/hono-notes): a small, complete project with every file `swp` needs.

## Frameworks

Where each framework's Worker entry lives, how to wrap it, and where to read `env` so the override applies.

- [TanStack Start](frameworks/tanstack-start.md)
- [Hono](frameworks/hono.md)
- [React Router v7](frameworks/react-router.md)
- [Astro](frameworks/astro.md)

## Fix

- [Troubleshooting](troubleshooting.md): symptoms phrased the way you would search for them, each with its cause and fix.

## Reference

- [How it works](how-it-works.md): every moving part, who owns it, and why it is built that way.
- [Configuration](configuration.md): commands, flags, environment, `swp.config.json`, the wrangler `previews` block, the GitHub Action and the runtime API.
- [Tokens](tokens.md): least-privilege Cloudflare, Supabase and GitHub credentials.
- [Security](security.md): what `swp` can touch, what is public, what is secret, and what a leaked token allows.
- [Compared with Vercel](vs-vercel.md): when Vercel and its Supabase integration are the better fit.
- [Measured platform behaviour](../skills/supabase-worker-previews/references/gotchas.md): what Cloudflare and Supabase actually did when measured, behind every design choice.

---

[Next: Concepts →](concepts.md)
