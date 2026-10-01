import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { checkLocal, compareVersions, hasDefaultPrivileges } from "../src/commands/doctor.js";
import { init, timestampBefore } from "../src/commands/init.js";
import { needsIsolatedDb, type PullRequestEvent } from "../src/commands/pr.js";
import { parseJsonc } from "../src/jsonc.js";
import { previewName } from "../src/preview-name.js";

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
});

describe("doctor", () => {
  const config = {
    worker: "app",
    supabaseProjectRef: PARENT,
    trunk: "main",
    sharedBranch: "preview",
    supabaseDir: "supabase",
    isolatedLabel: "isolated-db",
    checkPath: "/",
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
