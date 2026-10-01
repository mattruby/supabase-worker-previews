import { describe, expect, it } from "vitest";
import type { CloudflareApi, PreviewRecord } from "../src/cloudflare.js";
import type { Config } from "../src/config.js";
import type { Deps } from "../src/commands/branches.js";
import { openPullRequests, planPrune, prune, repoBranches, type RepoFacts } from "../src/commands/prune.js";
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
const facts: RepoFacts = {
  branches: ["main", "feat/open", "feat/wip", "feat/merged"],
  open: [{ number: 6, head: "feat/open" }],
  closedHeads: ["feat/merged"],
};
const supabaseBranches = () => [
  main,
  shared,
  branch("feat/open"),
  branch("feat/wip"),
  branch("feat/merged"),
  branch("feat/gone"),
];
const previews = () => [
  preview("main"),
  preview("feat/open"),
  preview("feat/wip", "wip-custom-slug"),
  preview("feat-wip-renamed", "feat-wip"),
  preview("feat/merged"),
  preview("feat/gone"),
];

describe("planPrune", () => {
  it("picks database branches whose git branch is gone or whose PR closed", () => {
    expect(planPrune(supabaseBranches(), [], facts, config).branches.map((b) => b.name)).toEqual([
      "feat/merged",
      "feat/gone",
    ]);
  });

  it("keeps the database of a branch that never had a PR", () => {
    const plan = planPrune([branch("feat/wip")], [], { ...facts, closedHeads: [] }, config);
    expect(plan.branches).toEqual([]);
  });

  it("keeps the database of a branch with an open PR, even if an older PR closed", () => {
    const plan = planPrune([branch("feat/open")], [], { ...facts, closedHeads: ["feat/open"] }, config);
    expect(plan.branches).toEqual([]);
  });

  it("picks only Previews whose git branch is gone, matching by name or slug", () => {
    expect(planPrune([], previews(), facts, config).previews.map((p) => p.name)).toEqual(["feat/gone"]);
  });

  it.each([
    ["a persistent branch", branch("old", { persistent: true })],
    ["the default branch", branch("old", { is_default: true })],
    ["the production project", branch("old", { project_ref: PARENT })],
    ["the shared branch by name", branch("preview", { git_branch: "old" })],
    ["a branch tracking the trunk", branch("old", { git_branch: "main" })],
    ["a branch without a git branch", branch("old", { git_branch: null })],
  ])("never picks %s", (_what, b) => {
    expect(planPrune([b], [], { branches: [], open: [], closedHeads: [] }, config).branches).toEqual([]);
  });

  it("never picks the trunk's Preview, by name or by slug, even when its branch is gone", () => {
    const trunk = { ...config, trunk: "release/2026" };
    const none: RepoFacts = { branches: [], open: [], closedHeads: [] };
    expect(
      planPrune([], [preview("release/2026", "custom"), preview("x", "release-2026")], none, trunk).previews,
    ).toEqual([]);
  });

  it("with previewName pr, picks only pr-<n> Previews whose PR is not open", () => {
    const plan = planPrune(
      [],
      [preview("pr-5"), preview("pr-6"), preview("feat/gone"), preview("pr-7-old")],
      facts,
      { ...config, previewName: "pr" },
    );
    expect(plan.previews.map((p) => p.name)).toEqual(["pr-5"]);
  });
});

function setup(github: (url: string) => Response, dryRun = false) {
  const deleted = { branches: [] as string[], previews: [] as string[] };
  const supabase = {
    listBranches: async () => supabaseBranches(),
    deleteBranch: async (ref: string) => deleted.branches.push(ref),
  } as unknown as SupabaseApi;
  const cloudflare = {
    listPreviews: async () => previews(),
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

const asked: string[] = [];
const github = (url: string) => {
  asked.push(url);
  const path = url.replace("https://api.github.com/repos/o/r/", "");
  if (path.startsWith("pulls?state=open")) return Response.json([{ number: 6, head: { ref: "feat/open" } }]);
  if (path.startsWith("branches")) return Response.json(facts.branches.map((name) => ({ name })));
  if (path.startsWith("pulls?state=closed"))
    return Response.json(path.includes(encodeURIComponent("o:feat/merged")) ? [{ number: 3 }] : []);
  return new Response("not found", { status: 404 });
};

describe("prune", () => {
  it("only prints the plan without --yes", async () => {
    const { deps, deleted } = setup(github);
    const plan = await prune({ ...deps, githubToken: "t", repo: "o/r", yes: false });
    expect(plan.branches.map((b) => b.name)).toEqual(["feat/merged", "feat/gone"]);
    expect(deleted).toEqual({ branches: [], previews: [] });
  });

  it("asks GitHub about closed PRs only for disposable branches that still exist without an open PR", async () => {
    asked.length = 0;
    const { deps } = setup(github);
    await prune({ ...deps, githubToken: "t", repo: "o/r", yes: false });
    expect(asked.filter((u) => u.includes("state=closed")).map((u) => decodeURIComponent(u))).toEqual([
      expect.stringContaining("head=o:feat/wip"),
      expect.stringContaining("head=o:feat/merged"),
    ]);
  });

  it("deletes the plan with --yes", async () => {
    const { deps, deleted } = setup(github);
    await prune({ ...deps, githubToken: "t", repo: "o/r", yes: true });
    expect(deleted).toEqual({
      branches: ["featmergedref", "featgoneref"],
      previews: ["feat/gone"],
    });
  });

  it("deletes nothing in a dry run, even with --yes", async () => {
    const { deps, deleted } = setup(github, true);
    await prune({ ...deps, githubToken: "t", repo: "o/r", yes: true });
    expect(deleted).toEqual({ branches: [], previews: [] });
  });

  it.each(["pulls?state=open", "branches"])(
    "deletes nothing when GitHub cannot answer %s",
    async (failing) => {
      const { deps, deleted } = setup((url) =>
        url.includes(`/o/r/${failing}`) ? new Response("bad credentials", { status: 401 }) : github(url),
      );
      await expect(prune({ ...deps, githubToken: "t", repo: "o/r", yes: true })).rejects.toThrow(/401/);
      expect(deleted).toEqual({ branches: [], previews: [] });
    },
  );
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

describe("repoBranches", () => {
  it("reads every page", async () => {
    const pages: string[] = [];
    const fetchImpl = (async (url: string) => {
      pages.push(url);
      return Response.json(
        Array.from({ length: pages.length === 1 ? 100 : 1 }, (_, i) => ({ name: `b${i}` })),
      );
    }) as unknown as typeof fetch;
    expect(await repoBranches("o/r", "t", fetchImpl)).toHaveLength(101);
    expect(pages[1]).toBe("https://api.github.com/repos/o/r/branches?per_page=100&page=2");
  });
});
