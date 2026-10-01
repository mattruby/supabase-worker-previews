import { afterEach, describe, expect, it } from "vitest";
import {
  cspNonce,
  injectIntoHtml,
  parseOverride,
  projectRefOf,
  publicConfigScript,
  readPublicConfig,
  resolveEnv,
  withSupabasePreviews,
} from "../src/runtime.js";

const override = {
  SUPABASE_URL: "https://ownrefownrefownref00.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "own-pub",
  SUPABASE_SERVICE_ROLE_KEY: "own-secret",
  SUPABASE_PROJECT_REF: "ownrefownrefownref00",
};

const baseEnv = {
  SUPABASE_URL: "https://sharedrefsharedref00.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "shared-pub",
  SUPABASE_PROJECT_REF: "sharedrefsharedref00",
  KV: { get: () => "binding" },
};

const htmlHandler = {
  fetch: async (_request: Request, _env: object, _ctx: unknown) =>
    new Response("<html><head><title>x</title></head></html>", { headers: { "content-type": "text/html" } }),
};

afterEach(() => {
  for (const k of [...Object.keys(override), "OTHER_API_KEY"]) delete process.env[k];
});

describe("resolveEnv", () => {
  it("leaves env alone without an override", () => {
    expect(resolveEnv(baseEnv)).toBe(baseEnv);
  });

  it("replaces the four Supabase values and keeps bindings", () => {
    const env = resolveEnv({ ...baseEnv, SUPABASE_OVERRIDE: JSON.stringify(override) });
    expect(env.SUPABASE_URL).toBe(override.SUPABASE_URL);
    expect((env as Record<string, unknown>).SUPABASE_SERVICE_ROLE_KEY).toBe("own-secret");
    expect(env.KV.get()).toBe("binding");
    expect(process.env.SUPABASE_PROJECT_REF).toBe(override.SUPABASE_PROJECT_REF);
  });

  it("rejects an incomplete override", () => {
    expect(() => parseOverride(JSON.stringify({ SUPABASE_URL: "x" }))).toThrow(/SUPABASE_PUBLISHABLE_KEY/);
  });
});

describe("public config", () => {
  it("escapes markup in the injected script", () => {
    const script = publicConfigScript({ supabaseUrl: "</script><b>", supabaseKey: "k" });
    expect(script).not.toContain("</script><b>");
  });

  it("reads back what the Worker injected", () => {
    const scope = { __SUPABASE_PUBLIC__: { supabaseUrl: "u", supabaseKey: "k" } };
    expect(readPublicConfig(undefined, scope)).toEqual({ supabaseUrl: "u", supabaseKey: "k" });
    expect(readPublicConfig(undefined, {})).toBeNull();
  });

  it("knows a project ref from its URL", () => {
    expect(projectRefOf("https://abcdefghijklmnopqrst.supabase.co")).toBe("abcdefghijklmnopqrst");
    expect(projectRefOf("https://api.example.com")).toBeNull();
  });

  it("injects into HTML only", async () => {
    const page = await injectIntoHtml(
      new Response('<html><head lang="en"><title>x</title>', { headers: { "content-type": "text/html" } }),
      "<script>1</script>",
    );
    expect(await page.text()).toBe('<html><head lang="en"><script>1</script><title>x</title>');
    const json = new Response("{}", { headers: { "content-type": "application/json" } });
    expect(await injectIntoHtml(json, "<script>1</script>")).toBe(json);
  });
});

describe("hardening", () => {
  it("applies only the four Supabase values from an override, never other keys", () => {
    const env = resolveEnv({
      ...baseEnv,
      OTHER_API_KEY: "real",
      SUPABASE_OVERRIDE: JSON.stringify({ ...override, OTHER_API_KEY: "hijacked" }),
    });
    expect(env.OTHER_API_KEY).toBe("real");
    expect(process.env.OTHER_API_KEY).toBeUndefined();
  });

  it("says what is wrong with an override that is not an object", () => {
    expect(() => parseOverride("null")).toThrow(/must be a JSON object/);
    expect(() => parseOverride("[]")).toThrow(/must be a JSON object/);
  });

  it("refuses a global name that is not an identifier", () => {
    expect(() => publicConfigScript({ supabaseUrl: "u", supabaseKey: "k" }, "x;alert(1)//")).toThrow(
      /not a JavaScript identifier/,
    );
  });

  it("finds the script nonce in a CSP header", () => {
    expect(cspNonce("default-src 'self'; script-src 'self' 'nonce-abc123'")).toBe("abc123");
    expect(cspNonce("default-src 'nonce-xyz'")).toBe("xyz");
    expect(cspNonce("script-src 'self'")).toBeUndefined();
    expect(cspNonce(null)).toBeUndefined();
  });

  it("adds the page's CSP nonce to the injected script", async () => {
    const worker = withSupabasePreviews({
      fetch: async (_request: Request, _env: object, _ctx: unknown) =>
        new Response("<html><head></head></html>", {
          headers: { "content-type": "text/html", "content-security-policy": "script-src 'nonce-r4nd0m'" },
        }),
    });
    const page = await worker.fetch(new Request("https://x/"), baseEnv, {});
    expect(await page.text()).toContain('<script nonce="r4nd0m">window.__SUPABASE_PUBLIC__=');
  });

  it("can emit a non-executing JSON block that readPublicConfig reads back", async () => {
    const worker = withSupabasePreviews(htmlHandler, { script: "json" });
    const html = await (await worker.fetch(new Request("https://x/"), baseEnv, {})).text();
    const block = /<script type="application\/json" id="__SUPABASE_PUBLIC__">(.*?)<\/script>/.exec(html);
    expect(block).not.toBeNull();
    const scope = { document: { getElementById: () => ({ textContent: block![1]! }) } };
    expect(readPublicConfig(undefined, scope)).toEqual({
      supabaseUrl: baseEnv.SUPABASE_URL,
      supabaseKey: baseEnv.SUPABASE_PUBLISHABLE_KEY,
    });
  });
});

describe("withSupabasePreviews", () => {
  it("serves the overridden database to the browser and the identity route", async () => {
    const worker = withSupabasePreviews(htmlHandler);
    const env = { ...baseEnv, SUPABASE_OVERRIDE: JSON.stringify(override) };
    const page = await worker.fetch(new Request("https://x/"), env, {});
    expect(await page.text()).toContain(override.SUPABASE_URL);
    const identity = await worker.fetch(new Request("https://x/.well-known/supabase-preview"), env, {});
    expect(await identity.json()).toEqual({
      projectRef: override.SUPABASE_PROJECT_REF,
      supabaseUrl: override.SUPABASE_URL,
    });
  });

  it("hands other handlers the resolved env", async () => {
    let seen: unknown;
    const worker = withSupabasePreviews({
      scheduled: async (_event: unknown, env: Record<string, unknown>) => {
        seen = env.SUPABASE_URL;
      },
    });
    await (worker.scheduled as (...a: unknown[]) => Promise<void>)(
      {},
      { ...baseEnv, SUPABASE_OVERRIDE: JSON.stringify(override) },
      {},
    );
    expect(seen).toBe(override.SUPABASE_URL);
  });

  it("reads process.env when the framework calls fetch without env", async () => {
    Object.assign(process.env, {
      SUPABASE_URL: baseEnv.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: baseEnv.SUPABASE_PUBLISHABLE_KEY,
      SUPABASE_OVERRIDE: JSON.stringify(override),
    });
    try {
      const worker = withSupabasePreviews(htmlHandler) as {
        fetch: (request: Request) => Promise<Response>;
      };
      const page = await worker.fetch(new Request("https://x/"));
      expect(await page.text()).toContain(override.SUPABASE_URL);
      const identity = await worker.fetch(new Request("https://x/.well-known/supabase-preview"));
      expect(await identity.json()).toMatchObject({ projectRef: override.SUPABASE_PROJECT_REF });
    } finally {
      delete process.env.SUPABASE_OVERRIDE;
    }
  });

  it("can turn off injection and the identity route", async () => {
    const worker = withSupabasePreviews(htmlHandler, { inject: false, identity: false });
    const page = await worker.fetch(new Request("https://x/.well-known/supabase-preview"), baseEnv, {});
    expect(await page.text()).not.toContain("supabase.co");
  });
});
