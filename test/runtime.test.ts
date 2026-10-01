import { afterEach, describe, expect, it } from "vitest";
import {
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
  for (const k of Object.keys(override)) delete process.env[k];
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
