import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { checkLocal, checkRemote, compareVersions, hasDefaultPrivileges } from "../src/commands/doctor.js";
import type { ActionRun, Branch, SupabaseApi } from "../src/supabase.js";
import { init, timestampBefore } from "../src/commands/init.js";
import { annotation, needsIsolatedDb, skipReason, type PullRequestEvent } from "../src/commands/pr.js";
import { parseJsonc } from "../src/jsonc.js";
import { previewName } from "../src/preview-name.js";
import { parseArgs, usageExitCode } from "../src/run.js";

const PARENT = "parentrefparentref00";
const GRANTS = readFileSync(join(import.meta.dirname, "..", "templates", "default-privileges.sql"), "utf8");

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "swp-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const wrangler = (previews: unknown, extra: object = {}) =>
  JSON.stringify({ name: "app", ...extra, ...(previews ? { previews } : {}) });

describe("previewName", () => {
  it("makes a DNS label", () => {
    expect(previewName("Feat/Big_Thing!")).toBe("feat-big-thing");
    expect(previewName("x".repeat(60))).toHaveLength(40);
    expect(() => previewName("///")).toThrow();
  });
});

describe("parseJsonc", () => {
  it("strips comments and trailing commas but not inside strings", () => {
    const text = `{
      // the worker
      "name": "app", /* inline */
      "url": "https://x.dev/a//b",
      "odd": "a,}",
      "list": [1, 2,],
    }`;
    expect(parseJsonc(text)).toEqual({ name: "app", url: "https://x.dev/a//b", odd: "a,}", list: [1, 2] });
  });
});

describe("loadConfig", () => {
  it("takes the worker name from wrangler and the rest from swp.config.json", () => {
    const dir = project({
      "wrangler.jsonc": wrangler(null),
      "swp.config.json": JSON.stringify({ supabaseProjectRef: PARENT, trunk: "develop" }),
    });
    expect(loadConfig({}, dir)).toMatchObject({
      worker: "app",
      supabaseProjectRef: PARENT,
      trunk: "develop",
      sharedBranch: "preview",
    });
  });

  it("requires the production project", () => {
    expect(() => loadConfig({}, project({ "wrangler.json": wrangler(null) }))).toThrow(/supabaseProjectRef/);
  });

  it("rejects an unknown choice", () => {
    const dir = project({
      "wrangler.jsonc": wrangler(null),
      "swp.config.json": JSON.stringify({ supabaseProjectRef: PARENT, apiKeys: "anon" }),
    });
    expect(() => loadConfig({}, dir)).toThrow(/"apiKeys" in swp.config.json must be "legacy" or "new"/);
  });

  it("reads the worker name from wrangler.toml", () => {
    const dir = project({
      "wrangler.toml": `# the worker\nname = "toml-app"\nmain = "src/worker.ts"\n`,
      "swp.config.json": JSON.stringify({ supabaseProjectRef: PARENT }),
    });
    expect(loadConfig({}, dir).worker).toBe("toml-app");
  });

  it("names the wrangler config it cannot parse", () => {
    expect(() => loadConfig({}, project({ "wrangler.toml": `name = "app` }))).toThrow(
      /Cannot parse wrangler.toml/,
    );
  });
});

describe("doctor", () => {
  const config: Config = {
    worker: "app",
    supabaseProjectRef: PARENT,
    trunk: "main",
    sharedBranch: "preview",
    supabaseDir: "supabase",
    isolatedLabel: "isolated-db",
    checkPath: "/",
    previewName: "branch",
    apiKeys: "legacy",
  };
  const levels = (dir: string) => checkLocal(config, dir).map((f) => `${f.level}: ${f.message}`);

  it("passes a complete setup", () => {
    const dir = project({
      "node_modules/wrangler/package.json": JSON.stringify({ version: "4.145.0" }),
      "wrangler.json": wrangler(
        {
          vars: { SUPABASE_URL: "https://sharedrefsharedref00.supabase.co", SUPABASE_PUBLISHABLE_KEY: "k" },
          kv_namespaces: [],
        },
        { kv_namespaces: [] },
      ),
      "supabase/migrations/20260101000000_grants.sql": GRANTS,
    });
    expect(levels(dir).filter((l) => !l.startsWith("ok"))).toEqual([]);
  });

  it("warns when static HTML would be served without the Worker", () => {
    const vars = { SUPABASE_URL: "https://sharedrefsharedref00.supabase.co", SUPABASE_PUBLISHABLE_KEY: "k" };
    const files = (assets: object) => ({
      "node_modules/wrangler/package.json": JSON.stringify({ version: "4.145.0" }),
      "wrangler.json": wrangler({ vars }, { assets }),
      "public/index.html": "<html><head></head></html>",
      "supabase/migrations/20260101000000_grants.sql": GRANTS,
    });
    expect(levels(project(files({ directory: "public" }))).join("\n")).toMatch(
      /warn: public has index.html; Cloudflare serves matching assets without running the Worker/,
    );
    const workerFirst = levels(project(files({ directory: "public", run_worker_first: true })));
    expect(workerFirst.filter((l) => !l.startsWith("ok"))).toEqual([]);
  });

  it("catches production in previews.vars, a secret in vars, a missing binding and a missing grants migration", () => {
    const dir = project({
      "node_modules/wrangler/package.json": JSON.stringify({ version: "4.131.0" }),
      "wrangler.json": wrangler(
        {
          vars: {
            SUPABASE_URL: `https://${PARENT}.supabase.co`,
            SUPABASE_PUBLISHABLE_KEY: "k",
            SUPABASE_SERVICE_ROLE_KEY: "s",
          },
        },
        { ratelimits: [] },
      ),
      "supabase/migrations/20260101000000_tables.sql": "create table t (id int);",
      "supabase/config.toml": "[auth]\nadditional_redirect_urls = []\n",
    });
    const out = levels(dir).join("\n");
    expect(out).toMatch(/error: wrangler 4.131.0/);
    expect(out).toMatch(/error: previews.vars points at the production project/);
    expect(out).toMatch(/error: previews.vars holds SUPABASE_SERVICE_ROLE_KEY/);
    expect(out).toMatch(/warn: "ratelimits" is bound at the top level/);
    expect(out).toMatch(/error: the first migration/);
    expect(out).toMatch(/warn: supabase\/config.toml/);
  });

  it("passes a complete wrangler.toml setup", () => {
    const dir = project({
      "node_modules/wrangler/package.json": JSON.stringify({ version: "4.145.0" }),
      "wrangler.toml": `name = "app"

[vars]
APP_NAME = "x"

[[kv_namespaces]]
binding = "CACHE"
id = "abc"

[previews.vars]
SUPABASE_URL = "https://sharedrefsharedref00.supabase.co"
SUPABASE_PUBLISHABLE_KEY = "k"
APP_NAME = "x"

[[previews.kv_namespaces]]
binding = "CACHE"
id = "abc"
`,
      "supabase/migrations/20260101000000_grants.sql": GRANTS,
    });
    expect(levels(dir).filter((l) => !l.startsWith("ok"))).toEqual([]);
    expect(levels(dir)).toContain("ok: previews.vars uses sharedrefsharedref00");
  });

  it("checks the previews block, its vars and bindings in wrangler.toml", () => {
    const dir = project({
      "wrangler.toml": `name = "app"

[vars]
APP_NAME = "x"

[[ratelimits]]
name = "LIMITER"

[previews.vars]
SUPABASE_URL = "https://${PARENT}.supabase.co"
SUPABASE_PUBLISHABLE_KEY = "k"
SUPABASE_OVERRIDE = "{}"
`,
    });
    const out = levels(dir).join("\n");
    expect(out).toMatch(/error: previews.vars points at the production project/);
    expect(out).toMatch(/error: previews.vars holds SUPABASE_OVERRIDE/);
    expect(out).toMatch(/warn: "ratelimits" is bound at the top level/);
    expect(out).toMatch(/warn: vars missing from previews.vars: APP_NAME/);
    expect(out).not.toMatch(/TOML/);
  });

  it("reports a wrangler.toml without a previews block", () => {
    const dir = project({ "wrangler.toml": `name = "app"\n` });
    expect(levels(dir).join("\n")).toMatch(/error: wrangler.toml has no "previews" block/);
  });

  it("recognises the grants migration", () => {
    expect(hasDefaultPrivileges(GRANTS)).toBe(true);
    expect(hasDefaultPrivileges("grant all on tables to anon;")).toBe(false);
  });

  it("compares versions", () => {
    expect(compareVersions("4.135.0", [4, 135, 0])).toBe(0);
    expect(compareVersions("4.99.9", [4, 135, 0])).toBeLessThan(0);
    expect(compareVersions("5.0.0-beta.1", [4, 135, 0])).toBeGreaterThan(0);
  });
});

describe("doctor online", () => {
  const config = loadConfig(
    { worker: "app", supabaseProjectRef: PARENT },
    mkdtempSync(join(tmpdir(), "swp-")),
  );
  const branches: Branch[] = [
    { id: "0", name: "main", project_ref: PARENT, is_default: true, git_branch: "", status: "" },
    {
      id: "1",
      name: "preview",
      project_ref: "sharedrefsharedref00",
      git_branch: "main",
      persistent: true,
      status: "",
    },
  ];
  const run = (git: ActionRun["git_config"]): ActionRun => ({ id: "r", git_config: git, created_at: "" });
  const remote = (runs: ActionRun[] | Error) =>
    checkRemote(
      config,
      {
        getProject: async () => ({}),
        listBranches: async () => branches,
        actionRuns: async (ref: string) => {
          if (ref === PARENT) throw new Error("asked the production project");
          if (runs instanceof Error) throw runs;
          return runs;
        },
      } as unknown as SupabaseApi,
      mkdtempSync(join(tmpdir(), "swp-")),
    ).then((out) => out.map((f) => `${f.level}: ${f.message}`).join("\n"));

  it("names the repo when a branch run came from GitHub", async () => {
    const out = await remote([run({ owner: "acme", repo: "app", ref: "main" }), run(null)]);
    expect(out).toMatch(/ok: Supabase builds "preview" from GitHub acme\/app/);
  });

  it("warns, saying what it cannot know, when no run came from GitHub", async () => {
    const out = await remote([run(null), run(null)]);
    expect(out).toMatch(/warn: cannot confirm the Supabase GitHub integration: none of the 2 runs/);
    expect(out).toMatch(/signed-in reads 403/);
  });

  it("warns when the runs cannot be read", async () => {
    expect(await remote(new Error("403"))).toMatch(/warn: cannot confirm .*no runs/);
  });
});

describe("init", () => {
  it("dates the grants migration before the existing ones", () => {
    expect(timestampBefore("20260914000000_x.sql")).toBe("20260913235959");
    const dir = project({
      "wrangler.jsonc": wrangler(null),
      "supabase/migrations/20260914000000_tables.sql": "create table t (id int);",
    });
    init({ supabaseProjectRef: PARENT, trunk: "main", log: () => {} }, dir);
    expect(readdirSync(join(dir, "supabase/migrations")).sort()[0]).toBe(
      "20260913235959_api_default_privileges.sql",
    );
    expect(JSON.parse(readFileSync(join(dir, "swp.config.json"), "utf8"))).toEqual({
      supabaseProjectRef: PARENT,
      trunk: "main",
    });
    expect(readFileSync(join(dir, ".github/workflows/supabase-previews.yml"), "utf8")).toContain(
      "npx swp pr",
    );
  });

  it("is idempotent", () => {
    const dir = project({ "wrangler.jsonc": wrangler(null) });
    init({ supabaseProjectRef: PARENT, log: () => {} }, dir);
    init({ supabaseProjectRef: PARENT, log: () => {} }, dir);
    expect(readdirSync(join(dir, "supabase/migrations"))).toHaveLength(1);
  });
});

describe("needsIsolatedDb", () => {
  const event = (labels: string[]): PullRequestEvent => ({
    action: "synchronize",
    number: 1,
    pull_request: { head: { ref: "feat/x", sha: "abc" }, labels: labels.map((name) => ({ name })) },
    repository: { full_name: "o/r" },
  });
  const config = loadConfig(
    { worker: "app", supabaseProjectRef: PARENT },
    mkdtempSync(join(tmpdir(), "swp-")),
  );

  it("isolates a PR that changes supabase/ or carries the label", () => {
    expect(needsIsolatedDb(event([]), ["src/a.ts"], config)).toBe(false);
    expect(needsIsolatedDb(event([]), ["supabase/migrations/1.sql"], config)).toBe(true);
    expect(needsIsolatedDb(event([]), ["supabase-docs/readme.md"], config)).toBe(false);
    expect(needsIsolatedDb(event(["isolated-db"]), [], config)).toBe(true);
  });
});

describe("skipReason", () => {
  const env = {
    SUPABASE_ACCESS_TOKEN: "s",
    CLOUDFLARE_API_TOKEN: "c",
    CLOUDFLARE_ACCOUNT_ID: "a",
    GITHUB_TOKEN: "g",
  };
  const event = (repo?: { full_name: string } | null): PullRequestEvent => ({
    action: "opened",
    number: 3,
    pull_request: {
      head: { ref: "feat/x", sha: "abc", ...(repo === undefined ? {} : { repo }) },
      labels: [],
    },
    repository: { full_name: "o/r" },
  });

  it("runs a same-repo PR with every secret", () => {
    expect(skipReason(event({ full_name: "o/r" }), env)).toBeNull();
    expect(skipReason(event(), env)).toBeNull();
  });

  it("skips a fork PR with a notice", () => {
    expect(skipReason(event({ full_name: "someone/r" }), {})).toEqual({
      level: "notice",
      message: expect.stringMatching(/fork someone\/r.*no secrets/),
    });
    expect(skipReason(event(null), env)?.message).toMatch(/a deleted fork/);
  });

  it("fails a person's PR whose secrets are empty, naming them", () => {
    const skip = skipReason(event({ full_name: "o/r" }), {
      ...env,
      GITHUB_ACTOR: "someone",
      SUPABASE_ACCESS_TOKEN: "",
      CLOUDFLARE_ACCOUNT_ID: undefined,
    });
    expect(skip).toEqual({
      level: "error",
      message: expect.stringMatching(/cannot check .*SUPABASE_ACCESS_TOKEN, CLOUDFLARE_ACCOUNT_ID are empty/),
    });
  });

  it("only warns for a bot PR without secrets", () => {
    const skip = skipReason(event({ full_name: "o/r" }), {
      ...env,
      GITHUB_ACTOR: "dependabot[bot]",
      SUPABASE_ACCESS_TOKEN: "",
    });
    expect(skip?.level).toBe("warning");
  });

  it("formats a single-line Actions annotation", () => {
    expect(annotation({ level: "warning", message: "50% done\nnext" })).toBe("::warning::50%25 done%0Anext");
  });
});

describe("usageExitCode", () => {
  const code = (...argv: string[]) => {
    const { positional, flags } = parseArgs(argv);
    return usageExitCode(positional, flags);
  };

  it("exits 0 when asked for help and 2 with no arguments", () => {
    expect(code("--help")).toBe(0);
    expect(code("help")).toBe(0);
    expect(code("doctor", "--help")).toBe(0);
    expect(code()).toBe(2);
    expect(code("doctor")).toBeUndefined();
  });
});
