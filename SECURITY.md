# Security policy

## Supported versions

Security fixes go into the latest minor release. While the package is 0.x, upgrade to the newest version to get them.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability** ([direct link](https://github.com/mattruby/supabase-worker-previews/security/advisories/new)). Do not open a public issue, pull request or discussion for a suspected vulnerability.

Include what an attacker could do, the steps to reproduce, and the versions of this package, wrangler and Node. Remove real tokens, keys and project refs from anything you send.

You should get an acknowledgement within a week. Once a fix is released, the advisory is published with credit to the reporter unless you ask otherwise.

## In scope

This package handles Supabase and Cloudflare credentials and decides which database a Preview serves, so these are especially relevant:

- a Preview, or its injected browser config, exposing production database credentials or a service role key;
- `supabase-worker-previews` leaking secrets into logs, workflow output or files it writes;
- `supabase-worker-previews check` passing while a Preview serves the production database.

Vulnerabilities in Supabase, Cloudflare or wrangler themselves belong with those vendors.
