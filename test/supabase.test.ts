import { describe, expect, it } from "vitest";
import { SupabaseApi, type ApiKey } from "../src/supabase.js";

const REF = "parentrefparentref00";

const legacy: ApiKey[] = [
  { name: "anon", type: "legacy", api_key: "eyJ.anon" },
  { name: "service_role", type: "legacy", api_key: "eyJ.service" },
];
const fresh: ApiKey[] = [
  { name: "default", type: "publishable", api_key: "sb_publishable_abc" },
  { name: "default", type: "secret", api_key: "sb_secret_abc" },
];

function api(routes: Record<string, { status?: number; body: unknown }>) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.supabase.com/v1", "");
    seen.push(`${init?.method ?? "GET"} ${path}`);
    const route = routes[path];
    if (!route) return new Response("not found", { status: 404 });
    const text = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(text, { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
  return { supabase: new SupabaseApi("token", fetchImpl), seen };
}

const keysRoute = (keys: ApiKey[], legacyEnabled = true) => ({
  [`/projects/${REF}/api-keys?reveal=true`]: { body: keys },
  [`/projects/${REF}/api-keys/legacy`]: { body: { enabled: legacyEnabled } },
});

describe("keys", () => {
  it("uses the legacy pair when that is all the project has", async () => {
    const { supabase } = api(keysRoute(legacy));
    expect(await supabase.keys(REF, "new")).toEqual({ publishable: "eyJ.anon", secret: "eyJ.service" });
  });

  it("uses the publishable and secret pair when that is all the project has", async () => {
    const { supabase } = api(keysRoute(fresh, false));
    expect(await supabase.keys(REF, "legacy")).toEqual({
      publishable: "sb_publishable_abc",
      secret: "sb_secret_abc",
    });
  });

  it("follows the preference when the project has both", async () => {
    const { supabase } = api(keysRoute([...legacy, ...fresh]));
    expect(await supabase.keys(REF, "legacy")).toEqual({ publishable: "eyJ.anon", secret: "eyJ.service" });
    expect(await supabase.keys(REF, "new")).toEqual({
      publishable: "sb_publishable_abc",
      secret: "sb_secret_abc",
    });
  });

  it("skips legacy keys the project has disabled", async () => {
    const { supabase } = api(keysRoute([...legacy, ...fresh], false));
    expect((await supabase.keys(REF, "legacy")).secret).toBe("sb_secret_abc");
  });

  it("prefers the key named default over other keys of its type", async () => {
    const { supabase } = api(
      keysRoute([
        { name: "ci", type: "secret", api_key: "sb_secret_ci" },
        ...fresh,
        { name: "mobile", type: "publishable", api_key: "sb_publishable_mobile" },
      ]),
    );
    expect(await supabase.keys(REF, "new")).toEqual({
      publishable: "sb_publishable_abc",
      secret: "sb_secret_abc",
    });
  });

  it("never hands out a masked secret key", async () => {
    const { supabase } = api(
      keysRoute([fresh[0]!, { name: "default", type: "secret", api_key: "sb_secret_ab·····" }]),
    );
    await expect(supabase.keys(REF, "new")).rejects.toThrow(/cannot reveal secret API keys/);
  });

  it("does not pair keys of different kinds", async () => {
    const { supabase } = api(keysRoute([legacy[0]!, fresh[1]!]));
    await expect(supabase.keys(REF)).rejects.toThrow(/no publishable and secret API key pair/);
  });
});

describe("createBranch", () => {
  const create = (status: number, body: unknown) =>
    api({ [`/projects/${REF}/branches`]: { status, body } }).supabase.createBranch(REF, { name: "feat/x" });

  it("says what to do when the project hit its branch limit, keeping Supabase's text", async () => {
    const body = {
      message: "Branch limit reached",
      error: {
        code: "entitlement_required",
        feature: "branching_limit",
        upgrade_url: "https://supabase.com/dashboard/org/acme/billing",
      },
    };
    const err = await create(402, body).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/reached its branch limit/);
    expect((err as Error).message).toMatch(/supabase-worker-previews prune/);
    expect((err as Error).message).toContain("https://supabase.com/dashboard/org/acme/billing");
    expect((err as Error).message).toContain("Branch limit reached");
  });

  it("recognises a limit from the message alone", async () => {
    await expect(create(400, { message: "Maximum number of branches reached" })).rejects.toThrow(
      /reached its branch limit/,
    );
  });

  it("explains a plan without persistent branches", async () => {
    const body = { error: { code: "entitlement_required", feature: "branching_persistent" } };
    await expect(create(402, body)).rejects.toThrow(/does not allow persistent branches/);
  });

  it("explains auth failures and keeps the raw response", async () => {
    await expect(create(403, { message: "forbidden" })).rejects.toThrow(
      /cannot create branches on .*Supabase said: 403 \{"message":"forbidden"\}/,
    );
    await expect(create(401, { message: "bad jwt" })).rejects.toThrow(/invalid or expired/);
  });

  it("passes an unrecognised failure through unchanged", async () => {
    await expect(create(500, "boom")).rejects.toThrow(
      `Supabase API POST /projects/${REF}/branches: 500 boom`,
    );
  });
});
