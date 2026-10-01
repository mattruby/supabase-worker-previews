#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { CloudflareApi } from "./cloudflare.js";
import { loadConfig, migrationFiles, type Config } from "./config.js";
import { check, down, shared, up, type Deps } from "./commands/branches.js";
import { checkLocal, checkRemote, type Finding } from "./commands/doctor.js";
import { init } from "./commands/init.js";
import { pr, readEvent } from "./commands/pr.js";
import { makeRunner, parseArgs, sleep } from "./run.js";
import { SupabaseApi } from "./supabase.js";

const USAGE = `swp: branch previews for Cloudflare Workers on Supabase branching

  swp init [--project-ref <ref>] [--trunk <branch>]   scaffold config, grants migration, workflow
  swp doctor                                          check the setup, offline and (with tokens) online
  swp shared                                          create or repair the shared Preview database
  swp up    [--branch <b>] [--pr <n>]                 give a branch's Preview its own database
  swp check [--branch <b>] [--pr <n>] [--isolated]    fail unless the Preview serves the right database
  swp down  [--branch <b>] [--pr <n>]                 delete the Preview and its own database
  swp pr                                              all of the above for a pull_request workflow

Flags: --dry-run, --env-file <path>, --worker <name>, --project-ref <ref>, --trunk <branch>
Env:   SUPABASE_ACCESS_TOKEN, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (and GITHUB_TOKEN for pr)`;

function currentBranch(flag: string | true | undefined): string {
  if (typeof flag === "string") return flag;
  if (process.env.WORKERS_CI_BRANCH) return process.env.WORKERS_CI_BRANCH;
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
}

function env(name: string, dryRun = false): string {
  const value = process.env[name];
  if (!value && !dryRun) throw new Error(`Missing ${name} in the environment`);
  return value ?? `<${name}>`;
}

function str(v: string | true | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function prNumber(flag: string | true | undefined): number | undefined {
  if (flag === undefined) return undefined;
  const n = Number(flag);
  if (!Number.isInteger(n) || n <= 0) throw new Error("--pr takes a pull request number");
  return n;
}

function report(findings: Finding[]): boolean {
  const mark = { ok: "✓", warn: "!", error: "✗" } as const;
  for (const f of findings) console.log(`${mark[f.level]} ${f.message}`);
  return !findings.some((f) => f.level === "error");
}

async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  if (!command || flags.help || command === "help") {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  const envFile = str(flags["env-file"]) ?? (existsSync(".env.swp") ? ".env.swp" : undefined);
  if (envFile) process.loadEnvFile(envFile);

  if (command === "init") {
    init({ supabaseProjectRef: str(flags["project-ref"]), trunk: str(flags.trunk) });
    return 0;
  }

  const config: Config = loadConfig({
    worker: str(flags.worker),
    supabaseProjectRef: str(flags["project-ref"]),
    trunk: str(flags.trunk),
  });

  if (command === "doctor") {
    let pass = report(checkLocal(config));
    if (process.env.SUPABASE_ACCESS_TOKEN)
      pass = report(await checkRemote(config, new SupabaseApi(process.env.SUPABASE_ACCESS_TOKEN))) && pass;
    else console.log("! SUPABASE_ACCESS_TOKEN not set; skipped the online checks");
    return pass ? 0 : 1;
  }

  const dryRun = flags["dry-run"] === true;
  const runner = makeRunner(dryRun);
  const deps: Deps = {
    config,
    runner,
    supabase: new SupabaseApi(env("SUPABASE_ACCESS_TOKEN")),
    cloudflare: new CloudflareApi(
      runner,
      { apiToken: env("CLOUDFLARE_API_TOKEN", dryRun), accountId: env("CLOUDFLARE_ACCOUNT_ID", dryRun) },
      config.worker,
    ),
    migrationCount: () => migrationFiles(config).length,
    sleep,
    fetchImpl: fetch,
  };

  switch (command) {
    case "shared":
      await shared(deps);
      return 0;
    case "up":
      await up(currentBranch(flags.branch), deps, prNumber(flags.pr));
      return 0;
    case "check":
      await check(currentBranch(flags.branch), flags.isolated === true, deps, prNumber(flags.pr));
      return 0;
    case "down":
      await down(currentBranch(flags.branch), deps, prNumber(flags.pr));
      return 0;
    case "pr":
      await pr(readEvent(), { ...deps, githubToken: env("GITHUB_TOKEN") });
      return 0;
    default:
      console.error(`Unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`swp: ${err.message}`);
    process.exit(1);
  },
);
