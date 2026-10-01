import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CloudflareApi } from "../src/cloudflare.js";
import { loadConfig } from "../src/config.js";
import { checkRemote, doctor, formatReport, type Section } from "../src/commands/doctor.js";
import { apiErrorMessage, summarizeBody } from "../src/http.js";
import { makeRunner, parseArgs } from "../src/run.js";
import { colorEnabled, makeStyle } from "../src/style.js";
import { didYouMean } from "../src/suggest.js";
import { SupabaseApi } from "../src/supabase.js";
import {
  COMMANDS,
  BOOLEAN_FLAGS,
  commandHelp,
  formatError,
  mainHelp,
  missingEnvMessage,
  resolveInvocation,
  version,
} from "../src/usage.js";

const PARENT = "parentrefparentref00";

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "swp-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const error = (...argv: string[]) => {
  const r = resolveInvocation(argv);
  return r.kind === "error" ? r.message : `not an error: ${r.kind}`;
};

describe("resolveInvocation", () => {
  it("prints the version for --version and -v", () => {
    expect(resolveInvocation(["--version"]).kind).toBe("version");
    expect(resolveInvocation(["-v"]).kind).toBe("version");
  });

  it("gives one command's help for `<command> --help` and `help <command>`", () => {
    for (const argv of [
      ["up", "--help"],
      ["help", "up"],
      ["up", "-h"],
    ]) {
      const r = resolveInvocation(argv);
      expect(r.kind === "help" && r.text).toMatch(
        /^supabase-worker-previews up: give a branch's Preview its own database/,
      );
    }
  });

  it("suggests the command meant by a typo", () => {
    expect(error("doctr")).toMatch(
      /^Unknown command "doctr". Did you mean "supabase-worker-previews doctor"\?/,
    );
    expect(error("help", "shard")).toMatch(/Did you mean "supabase-worker-previews shared"\?/);
    expect(error("frobnicate")).toMatch(
      /^Unknown command "frobnicate".\nRun supabase-worker-previews --help/,
    );
  });

  it("refuses unknown flags, suggesting the one meant", () => {
    expect(error("shared", "--dry-rn")).toMatch(/^Unknown flag --dry-rn. Did you mean --dry-run\?/);
    expect(error("init", "--hlp")).toMatch(/Did you mean --help\?/);
    expect(error("doctor", "--env-file", "x")).toMatch(/Unknown flag --env-file. Did you mean --dotenv\?/);
    expect(error("prune", "--isolated")).toMatch(/^prune does not take --isolated/);
  });

  it("refuses a value flag without its value, rather than falling back to a default", () => {
    expect(error("down", "--branch")).toMatch(/^--branch needs a value: --branch <b>/);
    expect(error("down", "--branch=")).toMatch(/--branch needs a value/);
    expect(error("prune", "--yes=no")).toMatch(/--yes takes no value/);
  });

  it("refuses stray arguments, pointing a branch name at --branch", () => {
    expect(error("up", "feat/x")).toMatch(
      /^up takes no arguments, but got "feat\/x". To name a branch, use --branch feat\/x/,
    );
    expect(error("doctor", "now")).not.toMatch(/--branch/);
  });

  it("keeps the command when a boolean flag comes first", () => {
    expect(resolveInvocation(["--dry-run", "up", "--branch", "feat/x"])).toEqual({
      kind: "run",
      command: "up",
      flags: { "dry-run": true, branch: "feat/x" },
    });
  });
});

describe("parseArgs", () => {
  it("keeps everything after the first = in a value", () => {
    expect(parseArgs(["--dotenv=a=b"]).flags).toEqual({ dotenv: "a=b" });
  });

  it("never lets a boolean flag take the next argument", () => {
    expect(parseArgs(["--yes", "extra"], BOOLEAN_FLAGS)).toEqual({
      positional: ["extra"],
      flags: { yes: true },
    });
  });
});

describe("help", () => {
  it("lists every command once, grouped, with the docs link and the version", () => {
    const text = mainHelp();
    for (const c of COMMANDS) expect(text).toMatch(new RegExp(`^  ${c.name} +${c.summary}`, "m"));
    expect(text).toMatch(/^Set up$/m);
    expect(text).toMatch(/^Per branch$/m);
    expect(text).toContain("https://github.com/mattruby/supabase-worker-previews#readme");
    expect(text).toContain(`supabase-worker-previews ${version()}`);
    expect(text).toContain("docs/tokens.md");
    expect(text).not.toContain("\u2014");
  });

  it("gives every command its own usage, flags and an example", () => {
    for (const c of COMMANDS) {
      const text = commandHelp(c);
      expect(text).toContain(`Usage: supabase-worker-previews ${c.name}`);
      expect(text).toMatch(/^Examples\n {2}supabase-worker-previews /m);
    }
    expect(commandHelp(COMMANDS.find((c) => c.name === "shared")!)).toContain(
      "Needs: SUPABASE_ACCESS_TOKEN, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID",
    );
  });

  it("reads the version from package.json", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
      version: string;
    };
    expect(version()).toBe(pkg.version);
  });

  it("suggests only close matches", () => {
    expect(didYouMean("chek", ["check", "shared"])).toBe("check");
    expect(didYouMean("supabaseprojectref", ["supabaseProjectRef"])).toBe("supabaseProjectRef");
    expect(didYouMean("zzz", ["check", "shared"])).toBeUndefined();
  });
});

describe("missingEnvMessage", () => {
  it("names every missing variable at once, with where to get it", () => {
    const text = missingEnvMessage("prune", false, { CLOUDFLARE_ACCOUNT_ID: "a" })!;
    expect(text).toMatch(/^prune needs these variables, not set:/);
    expect(text).toMatch(/SUPABASE_ACCESS_TOKEN +https:\/\/supabase.com\/dashboard\/account\/tokens/);
    expect(text).toMatch(/CLOUDFLARE_API_TOKEN +https:\/\/dash.cloudflare.com/);
    expect(text).toMatch(/GITHUB_TOKEN +`gh auth token`/);
    expect(text).not.toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(text).toContain("docs/tokens.md");
  });

  it("asks a dry run only for what it reads", () => {
    expect(missingEnvMessage("up", true, {})).toBeUndefined();
    expect(missingEnvMessage("shared", true, {})).toMatch(/needs this variable[\s\S]*SUPABASE_ACCESS_TOKEN/);
    expect(missingEnvMessage("doctor", false, {})).toBeUndefined();
  });
});

describe("errors", () => {
  it("names the host and system error of a network failure, without a stack", () => {
    const err = new TypeError("fetch failed", { cause: { code: "ENOTFOUND", hostname: "api.supabase.com" } });
    expect(formatError(err, false)).toBe(
      "network error reaching api.supabase.com: ENOTFOUND. Check the connection and try again.",
    );
    expect(formatError(new Error("plain"), false)).toBe("plain");
    expect(formatError(new Error("plain"), true)).toMatch(/^Error: plain\n {4}at /);
  });

  it("shortens API bodies and keeps the status", () => {
    expect(summarizeBody('{"message":"JWT could not be decoded"}')).toBe("JWT could not be decoded");
    expect(summarizeBody('{"errors":[{"code":10000,"message":"Authentication error"}]}')).toBe(
      "Authentication error",
    );
    expect(summarizeBody("<html><title>502 Bad Gateway</title><body>...</body></html>")).toBe(
      "502 Bad Gateway",
    );
    expect(summarizeBody("x".repeat(500))).toHaveLength(200);
    expect(apiErrorMessage("Supabase API GET /p", 401, '{"message":"bad"}', "SUPABASE_ACCESS_TOKEN")).toMatch(
      /^Supabase API GET \/p: 401 bad. SUPABASE_ACCESS_TOKEN is invalid or expired; see .*tokens.md$/,
    );
    expect(apiErrorMessage("X", 500, "", "T")).toBe("X: 500");
  });

  it("reports a Cloudflare failure that is not JSON by its status", async () => {
    const api = new CloudflareApi(
      makeRunner(false, () => {}),
      { apiToken: "t", accountId: "a" },
      "app",
      async () => new Response("<html><title>502 Bad Gateway</title></html>", { status: 502 }),
    );
    await expect(api.workersSubdomain()).rejects.toThrow(
      "Cloudflare API GET /workers/subdomain: 502 502 Bad Gateway",
    );
  });

  it("names the token a Supabase 403 is about", async () => {
    const api = new SupabaseApi("t", async () => new Response('{"message":"forbidden"}', { status: 403 }));
    await expect(api.listBranches(PARENT)).rejects.toThrow(
      /403 forbidden. SUPABASE_ACCESS_TOKEN lacks a permission this call needs/,
    );
  });

  it("names the command that failed", () => {
    const runner = makeRunner(false, () => {});
    expect(() => runner.exec(process.execPath, ["-e", "process.exit(3)"], { captureStderr: true })).toThrow(
      /^`.*node -e process.exit\(3\)` exited 3/,
    );
  });
});

describe("color", () => {
  it("colors only a terminal without NO_COLOR", () => {
    expect(colorEnabled({ isTTY: true }, {})).toBe(true);
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(colorEnabled({ isTTY: false }, {})).toBe(false);
    expect(colorEnabled({ isTTY: true }, { TERM: "dumb" })).toBe(false);
    expect(makeStyle(false).red("x")).toBe("x");
    expect(makeStyle(true).red("x")).toBe("\x1b[31mx\x1b[39m");
  });
});

describe("doctor report", () => {
  const wrangler = JSON.stringify({ name: "app" });

  it("still runs the local checks when the config is broken, and skips the online ones", async () => {
    const sections = await doctor({}, undefined, project({ "wrangler.json": wrangler }));
    const { text, pass } = formatReport(sections);
    expect(pass).toBe(false);
    expect(text).toMatch(
      /^Local files\n {2}✗ No supabase-worker-previews.json in this directory. Run `supabase-worker-previews init` first/,
    );
    expect(text).toMatch(/✗ wrangler.json has no "previews" block[^\n]*\n {4}→ Add "previews"/);
    expect(text).toMatch(/Supabase \(online\)\n {2}- skipped until the config above is fixed/);
    expect(text).toMatch(
      /\n\n\d+ errors, \d+ warnings? \(online checks skipped\). Fix the errors and run supabase-worker-previews doctor again.$/,
    );
  });

  it("says how to turn on the online checks", async () => {
    const dir = project({
      "wrangler.json": wrangler,
      "supabase-worker-previews.json": JSON.stringify({ supabaseProjectRef: PARENT }),
    });
    const { text } = formatReport(await doctor({}, undefined, dir));
    expect(text).toMatch(
      /- skipped: SUPABASE_ACCESS_TOKEN is not set. Add it to .env.supabase-worker-previews/,
    );
  });

  it("sums up a clean run, with warnings, and pluralizes", () => {
    const section = (findings: Section["findings"]): Section[] => [{ title: "Local files", findings }];
    expect(formatReport(section([{ level: "ok", message: "fine" }])).text).toMatch(/\n\nAll checks passed.$/);
    const warned = formatReport(section([{ level: "warn", message: "hm", fix: "do this" }]));
    expect(warned.pass).toBe(true);
    expect(warned.text).toMatch(/ {2}! hm\n {4}→ do this\n\nNo errors, 1 warning.$/);
  });

  it("reports branches it cannot list as that, not as branching being off", async () => {
    const config = loadConfig({ worker: "app", supabaseProjectRef: PARENT }, project({}));
    const findings = await checkRemote(
      config,
      {
        getProject: async () => ({}),
        listBranches: async () => {
          throw new Error("Supabase API GET /projects/x/branches: 403 forbidden");
        },
      } as unknown as SupabaseApi,
      project({}),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        level: "error",
        message: expect.stringMatching(/^cannot list the branches of/),
      }),
    ]);
  });
});
