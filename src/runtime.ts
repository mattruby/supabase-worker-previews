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
  const values: unknown = JSON.parse(raw);
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error(`${OVERRIDE_SECRET} must be a JSON object of the four SUPABASE_* values`);
  const picked = {} as SupabaseValues;
  for (const name of SUPABASE_VARS) {
    const value = (values as Record<string, unknown>)[name];
    if (typeof value !== "string" || !value) throw new Error(`${OVERRIDE_SECRET} is missing ${name}`);
    picked[name] = value;
  }
  return picked;
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

export type ScriptOptions = {
  /** `"json"` emits a non-executing data block, which a strict Content-Security-Policy allows. */
  script?: "inline" | "json";
  /** Nonce for the inline script, matching the page's CSP `script-src 'nonce-...'`. */
  nonce?: string;
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const NONCE = /^[A-Za-z0-9+/=_-]+$/;

export function publicConfigScript(
  config: PublicConfig,
  globalName = DEFAULT_GLOBAL,
  options: ScriptOptions = {},
): string {
  if (!IDENTIFIER.test(globalName))
    throw new Error(`globalName "${globalName}" is not a JavaScript identifier`);
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  if (options.script === "json") return `<script type="application/json" id="${globalName}">${json}</script>`;
  const nonce = options.nonce && NONCE.test(options.nonce) ? ` nonce="${options.nonce}"` : "";
  return `<script${nonce}>window.${globalName}=${json}</script>`;
}

/** The nonce a response's CSP allows scripts with: `script-src`, else `default-src`. */
export function cspNonce(csp: string | null): string | undefined {
  if (!csp) return undefined;
  const directives = new Map(
    csp.split(";").map((d) => {
      const [name = "", ...values] = d.trim().split(/\s+/);
      return [name.toLowerCase(), values] as const;
    }),
  );
  const sources = directives.get("script-src") ?? directives.get("default-src") ?? [];
  return sources.map((s) => /^'nonce-([^']+)'$/.exec(s)?.[1]).find((n) => n !== undefined);
}

type DocumentLike = { getElementById(id: string): { textContent: string | null } | null };

/** Browser side: the values the Worker injected, or null under a dev server that did not. */
export function readPublicConfig(
  globalName = DEFAULT_GLOBAL,
  scope: object = globalThis,
): PublicConfig | null {
  let value = (scope as Env)[globalName] as Partial<PublicConfig> | undefined;
  const doc = (scope as { document?: DocumentLike }).document;
  if (!value && doc) {
    const text = doc.getElementById(globalName)?.textContent;
    try {
      value = text ? (JSON.parse(text) as Partial<PublicConfig>) : undefined;
    } catch {
      value = undefined;
    }
  }
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
  /**
   * `"inline"` (default) sets `window[globalName]`, with the nonce from the response's CSP when it has one;
   * `"json"` emits a data block that `readPublicConfig()` parses, for a strict CSP without nonces.
   */
  script?: "inline" | "json";
};

/** Any Worker handler object, including `ExportedHandler<Env>`, whose `fetch` takes the workers `Request`. */
type Handler = { fetch?: (request: never, env: never, ctx: never) => unknown };

/** The env type a handler's `fetch` declares, so callers never pass it as a generic. */
type EnvOf<H> = H extends { fetch?: (request: never, env: infer E, ...rest: never[]) => unknown }
  ? E & object
  : object;

/**
 * Frameworks that call the entry without `env` (TanStack Start on nitro calls
 * `fetch(request)`) still expose vars and secrets on process.env under nodejs_compat.
 */
function envOrProcessEnv<E extends object>(env: E | undefined): E {
  if (env && typeof env === "object") return env;
  return ((globalThis as { process?: { env?: object } }).process?.env ?? {}) as E;
}

/**
 * Wraps a Worker's default export. Every handler sees the override applied;
 * `fetch` also injects the public config and answers the identity route that
 * `supabase-worker-previews check` reads.
 */
export function withSupabasePreviews<H extends object, E extends object = EnvOf<H>>(
  handler: H & Handler,
  options: PreviewOptions = {},
): H {
  const { globalName = DEFAULT_GLOBAL, inject = true, identity = true, script = "inline" } = options;
  const wrapped: Record<string, unknown> = { ...handler };
  for (const [name, fn] of Object.entries(handler)) {
    if (typeof fn !== "function" || name === "fetch") continue;
    wrapped[name] = (event: unknown, env: E, ctx: unknown) =>
      (fn as (...a: unknown[]) => unknown).call(handler, event, resolveEnv(envOrProcessEnv(env)), ctx);
  }
  if (handler.fetch) {
    const fetchFn = handler.fetch as unknown as (
      request: Request,
      env: E,
      ctx: unknown,
    ) => Response | Promise<Response>;
    wrapped.fetch = async (request: Request, rawEnv: E, ctx: unknown) => {
      const env = resolveEnv(envOrProcessEnv(rawEnv));
      if (identity && new URL(request.url).pathname === IDENTITY_PATH) return identityResponse(env);
      const response = await fetchFn.call(handler, request, env, ctx);
      const config = inject ? publicConfigFromEnv(env) : null;
      if (!config) return response;
      const nonce = cspNonce(response.headers.get("content-security-policy"));
      return injectIntoHtml(response, publicConfigScript(config, globalName, { script, nonce }));
    };
  }
  return wrapped as H;
}
