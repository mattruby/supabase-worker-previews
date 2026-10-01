#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { CloudflareApi } from "./cloudflare.js";
import { loadConfig, migrationFiles, type Config } from "./config.js";
import { check, down, shared, up, type Deps } from "./commands/branches.js";
import { doctor, formatReport } from "./commands/doctor.js";
import { init } from "./commands/init.js";
import { prune } from "./commands/prune.js";
import { annotation, pr, readEvent, skipReason } from "./commands/pr.js";
import { makeRunner, sleep } from "./run.js";
import { err as errStyle, out } from "./style.js";
import { SupabaseApi } from "./supabase.js";
import { formatError, missingEnvMessage, resolveInvocation, version } from "./usage.js";

function git(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function currentBranch(flag: string | true | undefined): string {
  if (typeof flag === "string") return flag;
  if (process.env.WORKERS_CI_BRANCH) return process.env.WORKERS_CI_BRANCH;
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch)
    throw new Error("Cannot tell the git branch here (not a git checkout?). Pass --branch <name>.");
  if (branch === "HEAD")
    throw new Error("HEAD is detached, so there is no branch to use. Pass --branch <name>.");
  return branch;
}

/** `owner/name` from a github.com origin remote, over https or ssh. */
function originRepo(): string | undefined {
  const url = git(["remote", "get-url", "origin"]);
  return url?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
}

function env(name: string): string {
  return process.env[name] || `<${name}>`;
}

function str(v: string | true | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function prNumber(flag: string | true | undefined): number | undefined {
  if (flag === undefined) return undefined;
  const n = Number(flag);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`--pr takes a pull request number, not "${String(flag)}"`);
  return n;
}

async function main(argv: string[]): Promise<number> {
  const invocation = resolveInvocation(argv, out);
  if (invocation.kind === "help") {
    console.log(invocation.text);
    return invocation.code;
  }
  if (invocation.kind === "version") {
    console.log(version());
    return 0;
  }
  if (invocation.kind === "error") {
    console.error(`${errStyle.red("swp:")} ${invocation.message}`);
    return 2;
  }
  const { command, flags } = invocation;
  const dryRun = flags["dry-run"] === true;

  const envFile = str(flags["env-file"]) ?? (existsSync(".env.swp") ? ".env.swp" : undefined);
  if (envFile) {
    if (!existsSync(envFile)) throw new Error(`--env-file ${envFile}: no such file`);
    process.loadEnvFile(envFile);
  }

  if (command === "init") {
    init({
      supabaseProjectRef: str(flags["project-ref"]),
      trunk: str(flags.trunk),
      action: flags.action === true,
      dryRun,
      log: (line) =>
        console.log(line.startsWith("+ ") ? out.green(line) : line.startsWith("- ") ? out.dim(line) : line),
    });
    return 0;
  }

  const overrides: Partial<Config> = {
    worker: str(flags.worker),
    supabaseProjectRef: str(flags["project-ref"]),
    trunk: str(flags.trunk),
    prComment: flags["no-comment"] ? false : undefined,
    githubDeployments: flags["no-deployments"] ? false : undefined,
  };

  if (command === "doctor") {
    const token = process.env.SUPABASE_ACCESS_TOKEN;
    const report = formatReport(await doctor(overrides, token ? new SupabaseApi(token) : undefined), out);
    console.log(report.text);
    return report.pass ? 0 : 1;
  }

  const config = loadConfig(overrides);
  const prNum = prNumber(flags.pr);
  const event = command === "pr" ? readEvent() : undefined;
  const skip = event && skipReason(event);
  if (skip) {
    console.log(annotation(skip));
    return skip.level === "error" ? 1 : 0;
  }
  const repo =
    command === "prune" ? (str(flags.repo) ?? process.env.GITHUB_REPOSITORY ?? originRepo()) : undefined;
  if (command === "prune" && !repo)
    throw new Error("Cannot tell the GitHub repo: pass --repo <owner/name>, or set GITHUB_REPOSITORY.");
  const missing = missingEnvMessage(command, dryRun);
  if (missing) throw new Error(missing);

  const runner = makeRunner(dryRun, (line) => console.log(line.startsWith("  $ ") ? out.dim(line) : line));
  if (dryRun) runner.log(out.dim("Dry run: reads only, changes nothing."));
  const deps: Deps = {
    config,
    runner,
    supabase: new SupabaseApi(env("SUPABASE_ACCESS_TOKEN")),
    cloudflare: new CloudflareApi(
      runner,
      { apiToken: env("CLOUDFLARE_API_TOKEN"), accountId: env("CLOUDFLARE_ACCOUNT_ID") },
      config.worker,
    ),
    migrationCount: () => migrationFiles(config).length,
    sleep,
    fetchImpl: fetch,
  };

  switch (command) {
    case "shared":
      await shared(deps);
      break;
    case "up":
      await up(currentBranch(flags.branch), deps, prNum);
      break;
    case "check":
      await check(currentBranch(flags.branch), flags.isolated === true, deps, prNum);
      break;
    case "down":
      await down(currentBranch(flags.branch), deps, prNum);
      break;
    case "pr":
      await pr(event!, { ...deps, githubToken: env("GITHUB_TOKEN") });
      break;
    case "prune":
      await prune({ ...deps, githubToken: env("GITHUB_TOKEN"), repo: repo!, yes: flags.yes === true });
      break;
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`${errStyle.red("swp:")} ${formatError(err)}`);
    process.exit(1);
  },
);
