import { describe, expect, it } from "vitest";
import { matchPreview, type CloudflareApi, type PreviewRecord } from "../src/cloudflare.js";
import type { Config } from "../src/config.js";
import {
  assertIsolated,
  check,
  down,
  enableBranching,
  servedRef,
  shared,
  up,
  waitForMigrations,
  type Deps,
} from "../src/commands/branches.js";
import type { Runner } from "../src/run.js";
import type { Branch, SupabaseApi } from "../src/supabase.js";

const PARENT = "parentrefparentref00";
const SHARED = "sharedrefsharedref00";
const OWN = "ownrefownrefownref00";

const config: Config = {
  worker: "app",
  supabaseProjectRef: PARENT,
  trunk: "main",
  sharedBranch: "preview",
  workersSubdomain: "acme",
  supabaseDir: "supabase",
  isolatedLabel: "isolated-db",
  checkPath: "/",
  apiKeys: "legacy",
};

const main: Branch = { id: "0", name: "main", project_ref: PARENT, is_default: true, status: "" };
const sharedBranch: Branch = {
  id: "1",
  name: "preview",
  project_ref: SHARED,
  git_branch: "main",
  persistent: true,
  status: "",
};

function fakeSupabase(branches: Branch[], extra: Partial<Record<keyof SupabaseApi, unknown>> = {}) {
  const log = {
    created: [] as unknown[],
    updated: [] as unknown[],
    deleted: [] as string[],
    redirects: [] as unknown[],
  };
  const supabase = {
    listBranches: async () => branches,
    createBranch: async (_ref: string, args: { name: string; gitBranch?: string }) => {
      log.created.push(args);
      const b: Branch = {
        id: "n",
        name: args.name,
        project_ref: OWN,
        git_branch: args.gitBranch,
        status: "",
      };
      branches.push(b);
      return b;
    },
    updateBranch: async (ref: string, args: unknown) => {
      log.updated.push({ ref, args });
      return {};
    },
    deleteBranch: async (ref: string) => {
      log.deleted.push(ref);
    },
    getBranch: async (ref: string) => ({ ref, status: "ACTIVE_HEALTHY" }),
    query: async () => [{ n: 3 }],
    keys: async () => ({ publishable: "pub-key", secret: "secret-key" }),
    allowRedirects: async (ref: string, site: string, urls: string[]) => {
      log.redirects.push({ ref, site, urls });
    },
    ...extra,
  } as unknown as SupabaseApi;
  return { supabase, log };
}

function record(name: string, deployed = true): PreviewRecord {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    id: slug,
    name,
    slug,
    urls: [`https://${slug}-app.acme.workers.dev`],
    deployed_on: deployed ? "2026-10-01T00:00:00Z" : null,
  };
}

function fakeCloudflare(
  previews: PreviewRecord[] = [record("feat/x"), record("feat/Notes"), record("main")],
) {
  const calls = {
    preview: [] as { name: string; secrets: Record<string, string> }[],
    base: [] as Record<string, string>[],
    deleted: [] as string[],
  };
  const cloudflare = {
    workersSubdomain: async () => "acme",
    putPreviewSecrets: (name: string, secrets: Record<string, string>) =>
      calls.preview.push({ name, secrets }),
    putBaseSecrets: (secrets: Record<string, string>) => calls.base.push(secrets),
    findPreview: async (branch: string) => matchPreview(previews, branch),
    deletePreview: (name: string) => calls.deleted.push(name),
  } as unknown as CloudflareApi;
  return { cloudflare, calls };
}

const quietRunner: Runner = { dryRun: false, log: () => {}, exec: () => "" };

function html(ref: string) {
  return new Response(`<script>createClient("https://${ref}.supabase.co","k")</script>`, {
    headers: { "content-type": "text/html" },
  });
}

function deps(supabase: SupabaseApi, cloudflare: CloudflareApi, extra: Partial<Deps> = {}): Deps {
  return {
    config,
    runner: quietRunner,
    supabase,
    cloudflare,
    migrationCount: () => 3,
    sleep: async () => {},
    fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch,
    ...extra,
  };
}

describe("up", () => {
  it("asks Supabase for a branch tied to the git branch and gives the Preview one override secret", async () => {
    const s = fakeSupabase([main, sharedBranch]);
    const c = fakeCloudflare();
    expect(await up("feat/Notes", deps(s.supabase, c.cloudflare))).toBe(OWN);
    expect(s.log.created).toEqual([{ name: "feat/Notes", gitBranch: "feat/Notes" }]);
    expect(c.calls.preview).toHaveLength(1);
    expect(c.calls.preview[0]!.name).toBe("feat/Notes");
    expect(JSON.parse(c.calls.preview[0]!.secrets.SUPABASE_OVERRIDE!)).toEqual({
      SUPABASE_URL: `https://${OWN}.supabase.co`,
      SUPABASE_PUBLISHABLE_KEY: "pub-key",
      SUPABASE_SERVICE_ROLE_KEY: "secret-key",
      SUPABASE_PROJECT_REF: OWN,
    });
    expect(s.log.redirects).toEqual([
      {
        ref: OWN,
        site: "https://feat-notes-app.acme.workers.dev",
        urls: ["https://feat-notes-app.acme.workers.dev/**"],
      },
    ]);
  });

  it("reuses the branch the GitHub integration already made", async () => {
    const own: Branch = {
      id: "2",
      name: "feat/Notes",
      project_ref: OWN,
      git_branch: "feat/Notes",
      status: "",
    };
    const s = fakeSupabase([main, sharedBranch, own]);
    expect(await up("feat/Notes", deps(s.supabase, fakeCloudflare().cloudflare))).toBe(OWN);
    expect(s.log.created).toEqual([]);
  });

  it("refuses when the git branch maps to the production project", async () => {
    const s = fakeSupabase([main, sharedBranch], {
      createBranch: async () => ({ id: "x", name: "x", project_ref: PARENT, status: "" }),
    });
    await expect(up("feat/x", deps(s.supabase, fakeCloudflare().cloudflare))).rejects.toThrow(
      /production project/,
    );
  });
});

describe("shared", () => {
  it("points the shared branch at the trunk and keeps only its secret key in the base config", async () => {
    const s = fakeSupabase([main, { ...sharedBranch, git_branch: null }]);
    const c = fakeCloudflare();
    expect(await shared(deps(s.supabase, c.cloudflare))).toBe(SHARED);
    expect(s.log.updated).toEqual([{ ref: SHARED, args: { gitBranch: "main", persistent: true } }]);
    expect(c.calls.base).toEqual([{ SUPABASE_SERVICE_ROLE_KEY: "secret-key" }]);
    expect(s.log.redirects[0]).toMatchObject({ urls: ["https://*-app.acme.workers.dev/**"] });
  });

  it("creates a persistent shared branch when there is none", async () => {
    const s = fakeSupabase([main]);
    await shared(deps(s.supabase, fakeCloudflare().cloudflare));
    expect(s.log.created).toEqual([{ name: "preview", gitBranch: "main", persistent: true }]);
  });
});

describe("enableBranching", () => {
  it("deletes the extra first branch when Supabase made a real database", async () => {
    const s = fakeSupabase([], {
      createBranch: async () => ({ id: "f", name: "production", project_ref: "firstref", status: "" }),
    });
    await enableBranching(deps(s.supabase, fakeCloudflare().cloudflare));
    expect(s.log.deleted).toEqual(["firstref"]);
  });

  it("leaves it alone when the first branch is the project itself", async () => {
    const s = fakeSupabase([], {
      createBranch: async () => ({ id: "f", name: "production", project_ref: PARENT, status: "" }),
    });
    await enableBranching(deps(s.supabase, fakeCloudflare().cloudflare));
    expect(s.log.deleted).toEqual([]);
  });
});

describe("check", () => {
  it("passes when the identity route reports the shared branch", async () => {
    const s = fakeSupabase([main, sharedBranch]);
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return Response.json({ projectRef: SHARED });
    }) as unknown as typeof fetch;
    await check("feat/x", false, deps(s.supabase, fakeCloudflare().cloudflare, { fetchImpl }));
    expect(seen).toEqual(["https://feat-x-app.acme.workers.dev/.well-known/supabase-preview"]);
  });

  it("waits while the Preview exists but was never deployed", async () => {
    const s = fakeSupabase([main, sharedBranch]);
    let fetched = 0;
    const fetchImpl = (async () => {
      fetched += 1;
      return Response.json({ projectRef: SHARED });
    }) as unknown as typeof fetch;
    await expect(
      check(
        "feat/x",
        false,
        deps(s.supabase, fakeCloudflare([record("feat/x", false)]).cloudflare, { fetchImpl }),
      ),
    ).rejects.toThrow(/never deployed/);
    expect(fetched).toBe(0);
  });

  it("falls back to the Supabase URL in the page", async () => {
    const s = fakeSupabase([main, sharedBranch]);
    const fetchImpl = (async (url: string) =>
      url.endsWith("supabase-preview")
        ? new Response("nope", { status: 404 })
        : html(SHARED)) as unknown as typeof fetch;
    await check("feat/x", false, deps(s.supabase, fakeCloudflare().cloudflare, { fetchImpl }));
  });

  it("fails at once when the Preview serves production", async () => {
    const s = fakeSupabase([main, sharedBranch]);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return Response.json({ projectRef: PARENT });
    }) as unknown as typeof fetch;
    await expect(
      check("feat/x", false, deps(s.supabase, fakeCloudflare().cloudflare, { fetchImpl })),
    ).rejects.toThrow(/production database/);
    expect(calls).toBe(1);
  });

  it("retries while the Preview still serves the shared branch and wants its own", async () => {
    const own: Branch = { id: "2", name: "feat/x", project_ref: OWN, git_branch: "feat/x", status: "" };
    const s = fakeSupabase([main, sharedBranch, own]);
    let calls = 0;
    const fetchImpl = (async () =>
      Response.json({ projectRef: ++calls < 3 ? SHARED : OWN })) as unknown as typeof fetch;
    await check("feat/x", true, deps(s.supabase, fakeCloudflare().cloudflare, { fetchImpl }));
    expect(calls).toBe(3);
  });

  it("does not pick between several databases in a page", async () => {
    const fetchImpl = (async (url: string) =>
      url.endsWith("supabase-preview")
        ? new Response("", { status: 404 })
        : new Response(
            `https://${SHARED}.supabase.co https://${PARENT}.supabase.co`,
          )) as unknown as typeof fetch;
    const s = fakeSupabase([]);
    const result = await servedRef("https://x", deps(s.supabase, fakeCloudflare().cloudflare, { fetchImpl }));
    expect(result.ref).toBeUndefined();
  });
});

describe("down", () => {
  it("deletes the PR's own branch and its Preview", async () => {
    const own: Branch = { id: "2", name: "feat/x", project_ref: OWN, git_branch: "feat/x", status: "" };
    const s = fakeSupabase([main, sharedBranch, own]);
    const c = fakeCloudflare();
    await down("feat/x", deps(s.supabase, c.cloudflare));
    expect(s.log.deleted).toEqual([OWN]);
    expect(c.calls.deleted).toEqual(["feat/x"]);
  });

  it("never deletes the persistent shared branch, even for the trunk", async () => {
    const s = fakeSupabase([main, sharedBranch]);
    await down("main", deps(s.supabase, fakeCloudflare().cloudflare));
    expect(s.log.deleted).toEqual([]);
  });
});

describe("waitForMigrations", () => {
  it("waits until the branch holds every local migration", async () => {
    let n = 0;
    const s = fakeSupabase([main], { query: async () => [{ n: ++n }] });
    await waitForMigrations(OWN, deps(s.supabase, fakeCloudflare().cloudflare));
    expect(n).toBe(3);
  });

  it("treats a 404 as not created yet", async () => {
    let calls = 0;
    const s = fakeSupabase([main], {
      getBranch: async (ref: string) => {
        if (++calls < 2) throw new Error("Supabase API GET /branches/x: 404 not found");
        return { ref, status: "CREATING_PROJECT" };
      },
    });
    await waitForMigrations(OWN, deps(s.supabase, fakeCloudflare().cloudflare));
    expect(calls).toBe(2);
  });

  it("stops on a failed branch", async () => {
    const s = fakeSupabase([main, { id: "2", name: "x", project_ref: OWN, status: "MIGRATIONS_FAILED" }], {
      query: async () => [{ n: 0 }],
    });
    await expect(waitForMigrations(OWN, deps(s.supabase, fakeCloudflare().cloudflare))).rejects.toThrow(
      /MIGRATIONS_FAILED/,
    );
  });
});

describe("matchPreview", () => {
  it("finds a Preview by its git branch name or by slug", () => {
    expect(matchPreview([record("docs/promote-trigger")], "docs/promote-trigger")?.slug).toBe(
      "docs-promote-trigger",
    );
    expect(matchPreview([{ ...record("x"), name: "feat-y", slug: "feat-y" }], "feat/y")?.name).toBe("feat-y");
    expect(matchPreview([record("feat/x")], "feat/z")).toBeUndefined();
  });
});

describe("assertIsolated", () => {
  it("rejects the default branch", () => {
    expect(() => assertIsolated(main, PARENT)).toThrow();
    expect(() => assertIsolated(sharedBranch, PARENT)).not.toThrow();
  });
});
