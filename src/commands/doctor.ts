import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationFiles, migrationsDir, readWranglerConfig, type Config } from "../config.js";
import { projectRefOf } from "../runtime.js";
import type { Branch, SupabaseApi } from "../supabase.js";

export type Finding = { level: "ok" | "warn" | "error"; message: string };

const MIN_WRANGLER = [4, 135, 0];

/** Binding keys a Preview does not inherit from the top-level config. */
const BINDING_KEYS = [
  "kv_namespaces",
  "d1_databases",
  "r2_buckets",
  "durable_objects",
  "queues",
  "services",
  "ratelimits",
  "vectorize",
  "hyperdrive",
  "ai",
  "browser",
  "images",
  "analytics_engine_datasets",
  "send_email",
  "workflows",
  "dispatch_namespaces",
  "mtls_certificates",
  "secrets_store_secrets",
  "version_metadata",
];

const SECRET_NAMES = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_OVERRIDE"];

export function hasDefaultPrivileges(sql: string): boolean {
  const s = sql.toLowerCase().replace(/\s+/g, " ");
  return /alter default privileges/.test(s) && /grant all on tables to [^;]*\b(anon|authenticated)\b/.test(s);
}

export function checkLocal(config: Config, cwd = process.cwd()): Finding[] {
  const out: Finding[] = [];
  const ok = (message: string) => out.push({ level: "ok", message });
  const warn = (message: string) => out.push({ level: "warn", message });
  const error = (message: string) => out.push({ level: "error", message });

  const version = installedWranglerVersion(cwd);
  if (!version) warn("wrangler is not installed in this project");
  else if (compareVersions(version, MIN_WRANGLER) < 0)
    error(`wrangler ${version} predates Worker Previews; install 4.135.0 or later`);
  else ok(`wrangler ${version}`);

  const wrangler = readWranglerConfig(cwd);
  if (!wrangler) error("no wrangler.jsonc, wrangler.json or wrangler.toml");
  else {
    const previews = wrangler.json.previews as Record<string, unknown> | undefined;
    if (!previews) error(`${wrangler.file} has no "previews" block, so Previews get no Supabase settings`);
    else {
      const vars = (previews.vars ?? {}) as Record<string, unknown>;
      const url = typeof vars.SUPABASE_URL === "string" ? vars.SUPABASE_URL : undefined;
      if (!url || !vars.SUPABASE_PUBLISHABLE_KEY)
        error(
          "previews.vars needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (run `swp shared` for the values)",
        );
      else if (projectRefOf(url) === config.supabaseProjectRef)
        error(`previews.vars points at the production project ${config.supabaseProjectRef}`);
      else ok(`previews.vars uses ${projectRefOf(url) ?? url}`);
      for (const name of SECRET_NAMES)
        if (name in vars) error(`previews.vars holds ${name}; secrets belong in the Preview base config`);
      for (const key of BINDING_KEYS) {
        if (!(key in wrangler.json) || key in previews) continue;
        warn(`"${key}" is bound at the top level but not in "previews"; Previews do not inherit bindings`);
      }
      const topVars = Object.keys(wrangler.json.vars ?? {}).filter((k) => !(k in vars));
      if (topVars.length) warn(`vars missing from previews.vars: ${topVars.join(", ")}`);
    }
  }

  const migrations = migrationFiles(config, cwd);
  if (!migrations.length) warn(`no migrations in ${migrationsDir(config)}`);
  else {
    const first = readFileSync(join(cwd, migrationsDir(config), migrations[0]!), "utf8");
    if (hasDefaultPrivileges(first)) ok(`${migrations[0]} grants the API roles default privileges`);
    else
      error(
        `the first migration (${migrations[0]}) does not grant default privileges; branch databases will 403 (run \`swp init\`)`,
      );
  }

  const toml = join(cwd, config.supabaseDir, "config.toml");
  if (existsSync(toml)) {
    const text = readFileSync(toml, "utf8");
    if (!/additional_redirect_urls[^\]]*workers\.dev/s.test(text))
      warn(
        `${config.supabaseDir}/config.toml additional_redirect_urls has no workers.dev entry; the integration resets branch auth URLs from it on every push`,
      );
  }
  return out;
}

export async function checkRemote(
  config: Config,
  supabase: SupabaseApi,
  cwd = process.cwd(),
): Promise<Finding[]> {
  const out: Finding[] = [];
  const parent = config.supabaseProjectRef;
  try {
    await supabase.getProject(parent);
  } catch (err) {
    return [{ level: "error", message: `cannot read project ${parent}: ${(err as Error).message}` }];
  }
  const branches = await supabase.listBranches(parent).catch(() => []);
  if (!branches.some((b) => b.is_default))
    out.push({
      level: "error",
      message: `branching is not enabled on ${parent} (connect the Supabase GitHub integration)`,
    });
  const shared = branches.find((b) => b.name === config.sharedBranch);
  const finding = await githubFinding(
    branches.filter((b) => !b.is_default && b.project_ref !== parent),
    shared,
    supabase,
  );
  if (finding) out.push(finding);
  if (!shared) {
    out.push({ level: "error", message: `no "${config.sharedBranch}" branch; run \`swp shared\`` });
    return out;
  }
  if (shared.project_ref === parent || shared.is_default)
    out.push({ level: "error", message: `"${config.sharedBranch}" is the production project itself` });
  if (!shared.persistent) out.push({ level: "warn", message: `"${config.sharedBranch}" is not persistent` });
  if (shared.git_branch !== config.trunk)
    out.push({
      level: "error",
      message: `"${config.sharedBranch}" tracks ${shared.git_branch ?? "no git branch"}, not ${config.trunk}`,
    });
  const vars = (readWranglerConfig(cwd)?.json.previews as { vars?: Record<string, string> } | undefined)
    ?.vars;
  const varsRef = projectRefOf(vars?.SUPABASE_URL);
  if (varsRef && varsRef !== shared.project_ref)
    out.push({
      level: "error",
      message: `previews.vars uses ${varsRef}, but "${config.sharedBranch}" is ${shared.project_ref}`,
    });
  else if (varsRef)
    out.push({
      level: "ok",
      message: `"${config.sharedBranch}" (${shared.project_ref}) tracks ${config.trunk}`,
    });
  return out;
}

/**
 * The Management API does not say whether a project is connected to GitHub.
 * Runs the integration made carry the repo in `git_config`, so look for one.
 */
async function githubFinding(
  branches: Branch[],
  shared: Branch | undefined,
  supabase: SupabaseApi,
): Promise<Finding | null> {
  const ordered = [...(shared ? [shared] : []), ...branches.filter((b) => b !== shared)].slice(0, 5);
  if (!ordered.length) return null;
  let runs = 0;
  for (const branch of ordered) {
    const list = await supabase.actionRuns(branch.project_ref).catch(() => null);
    if (!list) continue;
    runs += list.length;
    const git = list.find((r) => r.git_config?.repo)?.git_config;
    if (git)
      return {
        level: "ok",
        message: `Supabase builds "${branch.name}" from GitHub ${git.owner}/${git.repo}, so branches run the repo's migrations`,
      };
  }
  const names = ordered.map((b) => `"${b.name}"`).join(", ");
  return {
    level: "warn",
    message:
      `cannot confirm the Supabase GitHub integration: ${runs ? `none of the ${runs} runs` : "no runs"} on ${names} came from GitHub. ` +
      "Branching without Git copies the schema without privileges, so signed-in reads 403. " +
      "Connect the repo under Integrations, GitHub; if it is connected, push to the trunk and run doctor again",
  };
}

function installedWranglerVersion(cwd: string): string | null {
  const path = join(cwd, "node_modules", "wrangler", "package.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version : null;
}

export function compareVersions(version: string, min: number[]): number {
  const parts = version.split(/[.-]/).map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < min.length; i++) {
    const diff = (parts[i] ?? 0) - min[i]!;
    if (diff) return diff;
  }
  return 0;
}
