import { describe, expect, it } from "vitest";
import { matchPreview, type CloudflareApi, type PreviewRecord } from "../src/cloudflare.js";
import type { Config } from "../src/config.js";
import { pr, type PullRequestEvent } from "../src/commands/pr.js";
import { COMMENT_MARKER, Feedback, renderComment, warning, type FeedbackDeps } from "../src/feedback.js";
import type { Branch, SupabaseApi } from "../src/supabase.js";

const PARENT = "parentrefparentref00";
const SHARED = "sharedrefsharedref00";
const OWN = "ownrefownrefownref00";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PREVIEW_URL = "https://feat-x-app.acme.workers.dev";

const config: Config = {
  worker: "app",
  supabaseProjectRef: PARENT,
  trunk: "main",
  sharedBranch: "preview",
  workersSubdomain: "acme",
  supabaseDir: "supabase",
  isolatedLabel: "isolated-db",
  checkPath: "/",
};

const branches: Branch[] = [
  { id: "0", name: "main", project_ref: PARENT, is_default: true, status: "" },
  { id: "1", name: "preview", project_ref: SHARED, git_branch: "main", persistent: true, status: "" },
];
const ownBranch: Branch = { id: "2", name: "feat/x", project_ref: OWN, git_branch: "feat/x", status: "" };

const event = (action = "synchronize", labels: string[] = []): PullRequestEvent => ({
  action,
  number: 7,
  pull_request: { head: { ref: "feat/x", sha: SHA }, labels: labels.map((name) => ({ name })) },
  repository: { full_name: "o/r" },
});

type Call = { method: string; path: string; body?: Record<string, unknown> };

/** An in-memory GitHub REST API plus the Preview's identity route. */
function fakeGitHub(
  opts: { comments?: { id: number; body: string }[]; fail?: number; files?: string[] } = {},
) {
  const comments = [...(opts.comments ?? [])];
  const deployments: { id: number; environment: string; states: string[] }[] = [];
  const calls: Call[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    if (url.hostname.endsWith("workers.dev")) return Response.json({ projectRef: SHARED });
    const path = url.pathname.replace("/repos/o/r", "");
    if (path.endsWith("/files")) return Response.json((opts.files ?? []).map((filename) => ({ filename })));
    calls.push({ method, path, body });
    if (opts.fail)
      return new Response('{"message":"Resource not accessible by integration"}', { status: opts.fail });
    let m: RegExpExecArray | null;
    if (method === "GET" && path === "/issues/7/comments") return Response.json(comments);
    if (method === "POST" && path === "/issues/7/comments") {
      const comment = { id: 100 + comments.length, body: body!.body as string };
      comments.push(comment);
      return Response.json(comment, { status: 201 });
    }
    if (method === "PATCH" && (m = /^\/issues\/comments\/(\d+)$/.exec(path))) {
      const comment = comments.find((c) => c.id === Number(m![1]))!;
      comment.body = body!.body as string;
      return Response.json(comment);
    }
    if (method === "POST" && path === "/deployments") {
      const deployment = {
        id: 500 + deployments.length,
        environment: body!.environment as string,
        states: [],
      };
      deployments.unshift(deployment);
      return Response.json(deployment, { status: 201 });
    }
    if (method === "GET" && path === "/deployments")
      return Response.json(deployments.filter((d) => d.environment === url.searchParams.get("environment")));
    if ((m = /^\/deployments\/(\d+)\/statuses$/.exec(path))) {
      const deployment = deployments.find((d) => d.id === Number(m![1]))!;
      if (method === "GET") return Response.json(deployment.states.map((state) => ({ state })));
      deployment.states.unshift(body!.state as string);
      return Response.json({}, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { fetchImpl, comments, deployments, calls, writes };
}

function deps(fetchImpl: typeof fetch, extra: Partial<FeedbackDeps> = {}, withOwn = false) {
  const logs: string[] = [];
  const previews: PreviewRecord[] = [
    { id: "x", name: "feat/x", slug: "feat-x", urls: [`${PREVIEW_URL}/`], deployed_on: "2026-09-30" },
  ];
  const all = withOwn ? [...branches, ownBranch] : branches;
  const d: FeedbackDeps = {
    config,
    runner: { dryRun: false, log: (line) => logs.push(line), exec: () => "" },
    supabase: {
      listBranches: async () => all,
      deleteBranch: async () => {},
    } as unknown as SupabaseApi,
    cloudflare: {
      findPreview: async (b: string) => matchPreview(previews, b),
      deletePreview: () => {},
    } as unknown as CloudflareApi,
    migrationCount: () => 0,
    sleep: async () => {},
    fetchImpl,
    githubToken: "t",
    env: { GITHUB_RUN_ID: "42" },
    clock: () => new Date("2026-09-30T21:50:00Z"),
    ...extra,
  };
  return { deps: d, logs };
}

describe("renderComment", () => {
  const base = {
    worker: "app",
    sha: SHA,
    commitUrl: "https://github.com/o/r/pull/7/commits/" + SHA,
    dashboardUrl: `https://supabase.com/dashboard/project/${PARENT}/branches`,
    updated: new Date("2026-09-30T21:50:00Z"),
    runUrl: "https://github.com/o/r/actions/runs/42",
  };

  it("shows the Preview, its database, the result and the commit", () => {
    const body = renderComment({
      ...base,
      phase: "passed",
      previewUrl: PREVIEW_URL,
      database: { kind: "own", name: "feat/x", ref: OWN },
    });
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain(`[Visit Preview](${PREVIEW_URL})`);
    expect(body).toContain(`Own branch [\`feat/x\`](${base.dashboardUrl}) (\`${OWN}\`)`);
    expect(body).toContain("**Passed** ([logs](https://github.com/o/r/actions/runs/42))");
    expect(body).toContain(`[\`0123456\`](${base.commitUrl})`);
    expect(body).toContain("2026-09-30 21:50");
    expect(body).not.toContain("\u2014");
  });

  it("gives the reason for a failure", () => {
    const body = renderComment({
      ...base,
      phase: "failed",
      database: { kind: "shared", name: "preview", ref: SHARED },
      error: "The Preview of feat/x never served preview",
    });
    expect(body).toContain("| **Failed** (");
    expect(body).toContain("Not deployed yet");
    expect(body).toContain("Shared [`preview`]");
    expect(body).toContain("**Reason:** The Preview of feat/x never served preview");
  });

  it("says what was removed on close", () => {
    expect(renderComment({ ...base, phase: "removed", database: { kind: "own", name: "feat/x" } })).toContain(
      "The Preview and its own database `feat/x` were removed",
    );
    expect(renderComment({ ...base, phase: "removed" })).toContain("The shared database stays.");
  });

  it("keeps a branch name from breaking the table", () => {
    const body = renderComment({ ...base, phase: "checking", database: { kind: "own", name: "a|b" } });
    expect(body).toContain("`a\\|b`");
  });
});

describe("Feedback comment", () => {
  it("creates one comment, then updates it in place", async () => {
    const gh = fakeGitHub();
    await new Feedback(event(), deps(gh.fetchImpl).deps).run(false, async () => {});
    expect(
      gh
        .writes()
        .filter((c) => c.path.includes("comments"))
        .map((c) => c.method),
    ).toEqual(["POST", "PATCH"]);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain("**Passed**");
    expect(gh.comments[0]!.body).toContain(`Shared [\`preview\`]`);
    expect(gh.comments[0]!.body).toContain(`[Visit Preview](${PREVIEW_URL})`);
  });

  it("finds an earlier run's comment by its marker and ignores ones that only mention it", async () => {
    const gh = fakeGitHub({
      comments: [
        { id: 1, body: `Why does ${COMMENT_MARKER} show up?` },
        { id: 2, body: `${COMMENT_MARKER}\nold` },
      ],
    });
    await new Feedback(event(), deps(gh.fetchImpl).deps).run(false, async () => {});
    const patches = gh.writes().filter((c) => c.method === "PATCH");
    expect(patches.map((c) => c.path)).toEqual(["/issues/comments/2", "/issues/comments/2"]);
    expect(gh.writes().some((c) => c.method === "POST" && c.path.includes("comments"))).toBe(false);
    expect(gh.comments[0]!.body).toBe(`Why does ${COMMENT_MARKER} show up?`);
  });

  it("reports a failed check with its reason and still fails the run", async () => {
    const gh = fakeGitHub();
    const feedback = new Feedback(event(), deps(gh.fetchImpl, {}, true).deps);
    await expect(
      feedback.run(true, async () => {
        throw new Error("The Preview of feat/x never served the branch for feat/x");
      }),
    ).rejects.toThrow(/never served/);
    expect(gh.comments[0]!.body).toContain("**Failed**");
    expect(gh.comments[0]!.body).toContain(`Own branch [\`feat/x\`]`);
    expect(gh.comments[0]!.body).toContain(`(\`${OWN}\`)`);
    expect(gh.comments[0]!.body).toContain("**Reason:** The Preview of feat/x never served");
  });
});

describe("Feedback deployment", () => {
  it("records in_progress, then success with the Preview URL, and retires older deployments", async () => {
    const gh = fakeGitHub();
    await new Feedback(event(), deps(gh.fetchImpl).deps).run(false, async () => {});
    await new Feedback(event(), deps(gh.fetchImpl).deps).run(false, async () => {});
    const created = gh.writes().filter((c) => c.path === "/deployments");
    expect(created[0]!.body).toEqual({
      ref: SHA,
      environment: "Preview: feat/x",
      description: "Worker Preview of feat/x",
      auto_merge: false,
      required_contexts: [],
      transient_environment: true,
      production_environment: false,
    });
    const statuses = gh.writes().filter((c) => c.path.endsWith("/statuses"));
    expect(statuses[0]).toMatchObject({
      path: "/deployments/500/statuses",
      body: { state: "in_progress", log_url: "https://github.com/o/r/actions/runs/42" },
    });
    expect(statuses[1]).toMatchObject({
      path: "/deployments/500/statuses",
      body: { state: "success", environment_url: PREVIEW_URL },
    });
    expect(gh.deployments.map((d) => [d.id, d.states[0]])).toEqual([
      [501, "success"],
      [500, "inactive"],
    ]);
  });

  it("does not re-mark a deployment that is already inactive", async () => {
    const gh = fakeGitHub();
    for (let i = 0; i < 3; i++)
      await new Feedback(event(), deps(gh.fetchImpl).deps).run(false, async () => {});
    const inactive = gh.writes().filter((c) => c.body?.state === "inactive");
    expect(inactive.map((c) => c.path)).toEqual(["/deployments/500/statuses", "/deployments/501/statuses"]);
  });

  it("marks the deployment failed when the check fails", async () => {
    const gh = fakeGitHub();
    await new Feedback(event(), deps(gh.fetchImpl).deps)
      .run(false, async () => {
        throw new Error("boom");
      })
      .catch(() => {});
    expect(gh.deployments[0]!.states).toEqual(["failure", "in_progress"]);
  });
});

describe("Feedback on close", () => {
  it("says the Preview and its own database were removed and deactivates the deployments", async () => {
    const gh = fakeGitHub();
    await new Feedback(event(), deps(gh.fetchImpl, {}, true).deps).run(true, async () => {});
    let ran = false;
    await new Feedback(event("closed"), deps(gh.fetchImpl, {}, true).deps).close(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain("The Preview and its own database `feat/x` were removed");
    expect(gh.deployments[0]!.states[0]).toBe("inactive");
  });

  it("reports a failed cleanup and rethrows", async () => {
    const gh = fakeGitHub();
    await expect(
      new Feedback(event("closed"), deps(gh.fetchImpl).deps).close(async () => {
        throw new Error("wrangler exited 1");
      }),
    ).rejects.toThrow(/wrangler/);
    expect(gh.comments[0]!.body).toContain("**Cleanup failed**");
  });
});

describe("Feedback failures", () => {
  it("turns API errors into one warning per feature and never fails the run", async () => {
    const gh = fakeGitHub({ fail: 403 });
    const { deps: d, logs } = deps(gh.fetchImpl);
    await new Feedback(event(), d).run(false, async () => {});
    const warnings = logs.filter((l) => l.startsWith("::warning::"));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(
      /^::warning::PR comment skipped: GitHub API GET \/issues\/7\/comments\?per_page=100&page=1: 403/,
    );
    expect(warnings[1]).toMatch(/^::warning::GitHub deployment skipped: GitHub API POST \/deployments: 403/);
  });

  it("keeps the check's own error when feedback also fails", async () => {
    const gh = fakeGitHub({ fail: 500 });
    await expect(
      new Feedback(event(), deps(gh.fetchImpl).deps).run(false, async () => {
        throw new Error("serves the production database");
      }),
    ).rejects.toThrow(/production database/);
  });

  it("escapes newlines so a warning stays one workflow command", () => {
    expect(warning("a\nb 100%")).toBe("::warning::a%0Ab 100%25");
  });
});

describe("Feedback switches", () => {
  it("can turn off the comment and the deployment", async () => {
    const gh = fakeGitHub();
    const off = { ...config, prComment: false, githubDeployments: false };
    await new Feedback(event(), deps(gh.fetchImpl, { config: off }).deps).run(false, async () => {});
    expect(gh.calls).toEqual([]);
  });

  it("can turn off one and keep the other", async () => {
    const gh = fakeGitHub();
    const noComment = { ...config, prComment: false };
    await new Feedback(event(), deps(gh.fetchImpl, { config: noComment }).deps).run(false, async () => {});
    expect(gh.calls.some((c) => c.path.includes("comments"))).toBe(false);
    expect(gh.deployments).toHaveLength(1);
  });

  it("writes nothing in a dry run", async () => {
    const gh = fakeGitHub();
    const { deps: d } = deps(gh.fetchImpl);
    await new Feedback(event(), { ...d, runner: { ...d.runner, dryRun: true } }).run(false, async () => {});
    expect(gh.calls).toEqual([]);
  });
});

describe("pr", () => {
  it("wraps the database check in the comment and deployment", async () => {
    const gh = fakeGitHub({ files: ["src/a.ts"] });
    await pr(event(), deps(gh.fetchImpl).deps);
    expect(gh.comments[0]!.body).toContain("**Passed**");
    expect(gh.deployments[0]!.states[0]).toBe("success");
  });
});
