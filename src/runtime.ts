/**
 * Worker-side half: one build serves any Supabase database. The Worker reads
 * its Supabase values at request time (from wrangler vars, or a Preview's
 * SUPABASE_OVERRIDE secret) and hands the public ones to the browser, so a
 * Preview never needs its own build.
 */

export const OVERRIDE_SECRET = "SUPABASE_OVERRIDE";
export const DEFAULT_GLOBAL = "__SUPABASE_PUBLIC__";
export const IDENTITY_PATH = "/.well-known/supabase-preview";

export const SUPABASE_VARS = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_PROJECT_REF",
] as const;

export type SupabaseValues = Record<(typeof SUPABASE_VARS)[number], string>;
export type PublicConfig = { supabaseUrl: string; supabaseKey: string };
type Env = Record<string, unknown>;

/**
 * The override replaces all four values. It is one secret, not four, because a
 * Worker var and secret must never share a name.
 */
export function parseOverride(raw: unknown): SupabaseValues | null {
  if (typeof raw !== "string" || !raw) return null;
  const values = JSON.parse(raw) as Record<string, unknown>;
  for (const name of SUPABASE_VARS) {
    if (typeof values[name] !== "string" || !values[name])
      throw new Error(`${OVERRIDE_SECRET} is missing ${name}`);
  }
  return values as SupabaseValues;
}

/**
 * `env` with any SUPABASE_OVERRIDE applied. Also patches `process.env` when
 * nodejs_compat provides it, for code that reads Supabase settings from there.
 */
export function resolveEnv<E extends object>(env: E): E {
  const override = parseOverride((env as Env)[OVERRIDE_SECRET]);
  if (!override) return env;
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (proc?.env) Object.assign(proc.env, override);
  return new Proxy(env, {
    get: (target, key, receiver) =>
      typeof key === "string" && key in override
        ? override[key as keyof SupabaseValues]
        : Reflect.get(target, key, receiver),
  });
}

export function publicConfigFromEnv(env: object): PublicConfig | null {
  const { SUPABASE_URL: supabaseUrl, SUPABASE_PUBLISHABLE_KEY: supabaseKey } = env as Env;
  return typeof supabaseUrl === "string" && typeof supabaseKey === "string" && supabaseUrl && supabaseKey
    ? { supabaseUrl, supabaseKey }
    : null;
}

export function publicConfigScript(config: PublicConfig, globalName = DEFAULT_GLOBAL): string {
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  return `<script>window.${globalName}=${json}</script>`;
}

/** Browser side: the values the Worker injected, or null under a dev server that did not. */
export function readPublicConfig(
  globalName = DEFAULT_GLOBAL,
  scope: object = globalThis,
): PublicConfig | null {
  const value = (scope as Env)[globalName] as Partial<PublicConfig> | undefined;
  return value?.supabaseUrl && value.supabaseKey
    ? { supabaseUrl: value.supabaseUrl, supabaseKey: value.supabaseKey }
    : null;
}

/** `https://<ref>.supabase.co` gives `<ref>`; a custom API domain gives null. */
export function projectRefOf(url: string | undefined): string | null {
  return url?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/)?.[1] ?? null;
}

type HtmlRewriterLike = {
  on(
    selector: string,
    handlers: { element(el: { prepend(html: string, opts: { html: true }): void }): void },
  ): HtmlRewriterLike;
  transform(response: Response): Response;
};

export async function injectIntoHtml(response: Response, html: string): Promise<Response> {
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) return response;
  const Rewriter = (globalThis as { HTMLRewriter?: new () => HtmlRewriterLike }).HTMLRewriter;
  if (Rewriter) {
    return new Rewriter()
      .on("head", { element: (el) => el.prepend(html, { html: true }) })
      .transform(response);
  }
  const body = (await response.text()).replace(/<head(\s[^>]*)?>/i, (head) => head + html);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

export function identityResponse(env: object): Response {
  const url = (env as Env).SUPABASE_URL as string | undefined;
  const ref = ((env as Env).SUPABASE_PROJECT_REF as string | undefined) ?? projectRefOf(url);
  return Response.json(
    { projectRef: ref ?? null, supabaseUrl: url ?? null },
    { headers: { "cache-control": "no-store" } },
  );
}

export type PreviewOptions = {
  /** Window property the browser reads the public config from. */
  globalName?: string;
  /** Inject the public config into HTML responses. Default true. */
  inject?: boolean;
  /** Serve which database this deployment uses at /.well-known/supabase-preview. Default true. */
  identity?: boolean;
};

type Handler<E> = {
  fetch?: (request: Request, env: E, ctx: any) => Response | Promise<Response>;
  [key: string]: unknown;
};

/**
 * Wraps a Worker's default export. Every handler sees the override applied;
 * `fetch` also injects the public config and answers the identity route that
 * `swp check` reads.
 */
export function withSupabasePreviews<E extends object, H extends Handler<E>>(
  handler: H,
  options: PreviewOptions = {},
): H {
  const { globalName = DEFAULT_GLOBAL, inject = true, identity = true } = options;
  const wrapped: Record<string, unknown> = { ...handler };
  for (const [name, fn] of Object.entries(handler)) {
    if (typeof fn !== "function" || name === "fetch") continue;
    wrapped[name] = (event: unknown, env: E, ctx: unknown) =>
      (fn as (...a: unknown[]) => unknown).call(handler, event, resolveEnv(env), ctx);
  }
  if (handler.fetch) {
    const fetchFn = handler.fetch;
    wrapped.fetch = async (request: Request, rawEnv: E, ctx: unknown) => {
      const env = resolveEnv(rawEnv);
      if (identity && new URL(request.url).pathname === IDENTITY_PATH) return identityResponse(env);
      const response = await fetchFn.call(handler, request, env, ctx);
      const config = inject ? publicConfigFromEnv(env) : null;
      return config ? injectIntoHtml(response, publicConfigScript(config, globalName)) : response;
    };
  }
  return wrapped as H;
}
