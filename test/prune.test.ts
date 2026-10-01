import { describe, expect, it } from "vitest";
import type { CloudflareApi, PreviewRecord } from "../src/cloudflare.js";
import type { Config } from "../src/config.js";
import type { Deps } from "../src/commands/branches.js";
import { openPullRequests, planPrune, prune } from "../src/commands/prune.js";
import type { Runner } from "../src/run.js";
import type { Branch, SupabaseApi } from "../src/supabase.js";

const PARENT = "parentrefparentref00";

const config: Config = {
  worker: "app",
  supabaseProjectRef: PARENT,
  trunk: "main",
  sharedBranch: "preview",
  workersSubdomain: "acme",
  supabaseDir: "supabase",
  isolatedLabel: "isolated-db",
  checkPath: "/",
  previewName: "branch",
  apiKeys: "legacy",
};

const branch = (name: string, patch: Partial<Branch> = {}): Branch => ({
  id: name,
  name,
  project_ref: `${name.replace(/\W/g, "")}ref`,
  git_branch: name,
  status: "",
  ...patch,
});

const preview = (name: string, slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-")): PreviewRecord => ({
  id: slug,
  name,
  slug,
  urls: [],
  deployed_on: null,
});

const main = branch("main", { project_ref: PARENT, is_default: true, git_branch: "" });
const shared = branch("preview", { git_branch: "main", persistent: true });
const open = [{ number: 6, head: "feat/open" }];

describe("planPrune", () => {
  it("picks branches and Previews whose git branch has no open PR", () => {
    const plan = planPrune(
      [main, shared, branch("feat/open"), branch("feat/gone")],
      [
        preview("feat/open"),
        preview("feat-open-renamed", "feat-open"),
        preview("feat/gone"),
        preview("main"),
      ],
      open,
      config,
    );
    expect(plan.branches.map((b) => b.name)).toEqual(["feat/gone"]);
    expect(plan.previews.map((p) => p.name)).toEqual(["feat/gone"]);
  });

  it.each([
    ["a persistent branch", branch("old", { persistent: true })],
    ["the default branch", branch("old", { is_default: true })],
    ["the production project", branch("old", { project_ref: PARENT })],
    ["the shared branch by name", branch("preview", { git_branch: "old" })],
    ["a branch tracking the trunk", branch("old", { git_branch: "main" })],
    ["a branch without a git branch", branch("old", { git_branch: null })],
  ])("never picks %s", (_what, b) => {
    expect(planPrune([b], [], [], config).branches).toEqual([]);
  });

  it("never picks the trunk's Preview, by name or by slug", () => {
    const trunk = { ...config, trunk: "release/2026" };
    expect(
      planPrune([], [preview("release/2026", "custom"), preview("x", "release-2026")], [], trunk).previews,
    ).toEqual([]);
  });

  it("with previewName pr, picks only pr-<n> Previews of closed PRs", () => {
    const plan = planPrune(
      [],
      [preview("pr-5"), preview("pr-6"), preview("feat/x"), preview("pr-7-old")],
      open,
      { ...config, previewName: "pr" },
    );
    expect(plan.previews.map((p) => p.name)).toEqual(["pr-5"]);
  });
});

function setup(github: (url: string) => Response, dryRun = false) {
  const deleted = { branches: [] as string[], previews: [] as string[] };
  const supabase = {
    listBranches: async () => [main, shared, branch("feat/open"), branch("feat/gone")],
    deleteBranch: async (ref: string) => deleted.branches.push(ref),
  } as unknown as SupabaseApi;
  const cloudflare = {
    listPreviews: async () => [preview("main"), preview("feat/open"), preview("feat/gone")],
    deletePreview: (name: string) => deleted.previews.push(name),
  } as unknown as CloudflareApi;
  const runner: Runner = { dryRun, log: () => {}, exec: () => "" };
  const deps: Deps = {
    config,
    runner,
    supabase,
    cloudflare,
    migrationCount: () => 0,
    sleep: async () => {},
    fetchImpl: (async (url: string) => github(url)) as unknown as typeof fetch,
  };
  return { deps, deleted };
}

const github = () => Response.json([{ number: 6, head: { ref: "feat/open" } }]);

describe("prune", () => {
  it("only prints the plan without --yes", async () => {
    const { deps, deleted } = setup(github);
    const plan = await prune({ ...deps, githubToken: "t", repo: "o/r", yes: false });
    expect(plan.branches).toHaveLength(1);
    expect(deleted).toEqual({ branches: [], previews: [] });
  });

  it("deletes the plan with --yes", async () => {
    const { deps, deleted } = setup(github);
    await prune({ ...deps, githubToken: "t", repo: "o/r", yes: true });
    expect(deleted).toEqual({ branches: ["featgoneref"], previews: ["feat/gone"] });
  });

  it("deletes nothing in a dry run, even with --yes", async () => {
    const { deps, deleted } = setup(github, true);
    await prune({ ...deps, githubToken: "t", repo: "o/r", yes: true });
    expect(deleted).toEqual({ branches: [], previews: [] });
  });

  it("deletes nothing when GitHub cannot list the open PRs", async () => {
    const { deps, deleted } = setup(() => new Response("bad credentials", { status: 401 }));
    await expect(prune({ ...deps, githubToken: "t", repo: "o/r", yes: true })).rejects.toThrow(/401/);
    expect(deleted).toEqual({ branches: [], previews: [] });
  });
});

describe("openPullRequests", () => {
  it("reads every page", async () => {
    const pages: string[] = [];
    const fetchImpl = (async (url: string) => {
      pages.push(url);
      const n = pages.length === 1 ? 100 : 3;
      return Response.json(Array.from({ length: n }, (_, i) => ({ number: i, head: { ref: `b${i}` } })));
    }) as unknown as typeof fetch;
    expect(await openPullRequests("o/r", "t", fetchImpl)).toHaveLength(103);
    expect(pages[1]).toContain("state=open&per_page=100&page=2");
  });
});
