import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DEFAULTS,
  CONFIG_FILE,
  configFileIn,
  defined,
  DOTENV_FILE,
  LEGACY_CONFIG_FILE,
  LEGACY_DOTENV_FILE,
  loadConfig,
  migrationFiles,
  migrationsDir,
  readWranglerConfig,
  type Config,
} from "../config.js";
import { TOKENS_URL } from "../http.js";
import { projectRefOf } from "../runtime.js";
import { makeStyle, type Style } from "../style.js";
import type { Branch, SupabaseApi } from "../supabase.js";

/** `fix` says what to do next, for a warning or an error. */
export type Finding = { level: "ok" | "warn" | "error"; message: string; fix?: string };

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
  const warn = (message: string, fix: string) => out.push({ level: "warn", message, fix });
  const error = (message: string, fix: string) => out.push({ level: "error", message, fix });
  const shared = "Run `supabase-worker-previews shared` and paste the values it prints into previews.vars.";

  const version = installedWranglerVersion(cwd);
  if (!version)
    warn(
      "wrangler is not installed in this project",
      "npm install --save-dev wrangler@latest (4.135.0 or later)",
    );
  else if (compareVersions(version, MIN_WRANGLER) < 0)
    error(
      `wrangler ${version} predates Worker Previews`,
      "npm install --save-dev wrangler@latest (4.135.0 or later)",
    );
  else ok(`wrangler ${version}`);

  const wrangler = readWranglerConfig(cwd);
  if (!wrangler)
    error(
      "no wrangler.jsonc, wrangler.json or wrangler.toml here",
      "Run supabase-worker-previews doctor in the Worker's directory.",
    );
  else {
    const previews = wrangler.json.previews as Record<string, unknown> | undefined;
    if (!previews)
      error(
        `${wrangler.file} has no "previews" block, so Previews get no Supabase settings`,
        'Add "previews": { "vars": {} }, redeclaring every binding the Worker uses, then run `supabase-worker-previews shared` for the vars.',
      );
    else {
      const vars = (previews.vars ?? {}) as Record<string, unknown>;
      const url = typeof vars.SUPABASE_URL === "string" ? vars.SUPABASE_URL : undefined;
      if (!url || !vars.SUPABASE_PUBLISHABLE_KEY)
        error("previews.vars needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY", shared);
      else if (projectRefOf(url) === config.supabaseProjectRef)
        error(`previews.vars points at the production project ${config.supabaseProjectRef}`, shared);
      else ok(`previews.vars uses ${projectRefOf(url) ?? url}`);
      for (const name of SECRET_NAMES)
        if (name in vars)
          error(
            `previews.vars holds ${name}; secrets belong in the Preview base config`,
            `Remove ${name} from previews.vars (supabase-worker-previews stores it as a secret), and rotate the key if it was committed.`,
          );
      for (const key of BINDING_KEYS) {
        if (!(key in wrangler.json) || key in previews) continue;
        warn(
          `"${key}" is bound at the top level but not in "previews"; Previews do not inherit bindings`,
          `Redeclare "${key}" under "previews", pointing at Preview-safe resources.`,
        );
      }
      const topVars = Object.keys(wrangler.json.vars ?? {}).filter((k) => !(k in vars));
      if (topVars.length)
        warn(
          `vars missing from previews.vars: ${topVars.join(", ")}`,
          "Copy them into previews.vars; Previews do not inherit vars.",
        );
    }
    const assets = wrangler.json.assets as { directory?: string; run_worker_first?: unknown } | undefined;
    const html = assets?.directory ? htmlFiles(join(cwd, assets.directory)) : [];
    if (html.length && !assets?.run_worker_first)
      warn(
        `${assets!.directory} has ${html.join(", ")}; Cloudflare serves matching assets without running the Worker, ` +
          "so those pages get no Supabase config and the browser falls back to build-time values",
        'Set "run_worker_first": true under "assets" (or list the HTML routes).',
      );
  }

  const migrations = migrationFiles(config, cwd);
  if (!migrations.length)
    warn(
      `no migrations in ${migrationsDir(config)}`,
      'Commit your migrations there, or set "supabaseDir" in supabase-worker-previews.json.',
    );
  else {
    const first = readFileSync(join(cwd, migrationsDir(config), migrations[0]!), "utf8");
    if (hasDefaultPrivileges(first)) ok(`${migrations[0]} grants the API roles default privileges`);
    else
      error(
        `the first migration (${migrations[0]}) does not grant default privileges; branch databases will 403`,
        "Run `supabase-worker-previews init` to add the grants migration before it.",
      );
  }

  const toml = join(cwd, config.supabaseDir, "config.toml");
  if (existsSync(toml)) {
    const text = readFileSync(toml, "utf8");
    if (!/additional_redirect_urls[^\]]*workers\.dev/s.test(text))
      warn(
        `${config.supabaseDir}/config.toml additional_redirect_urls has no workers.dev entry; the integration resets branch auth URLs from it on every push`,
        `Add "https://*-${config.worker || "<worker>"}.<subdomain>.workers.dev/**" to [auth] additional_redirect_urls.`,
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
    const status = (err as { status?: number }).status;
    return [
      {
        level: "error",
        message: `cannot read project ${parent}: ${(err as Error).message}`,
        ...(status === 404 && {
          fix: `Check "supabaseProjectRef" in supabase-worker-previews.json, and that SUPABASE_ACCESS_TOKEN can reach that project.`,
        }),
      },
    ];
  }
  let branches: Branch[];
  try {
    branches = await supabase.listBranches(parent);
  } catch (err) {
    return [
      {
        level: "error",
        message: `cannot list the branches of ${parent}: ${(err as Error).message}`,
        fix: `The token needs Development Branches: Read-write (${TOKENS_URL}).`,
      },
    ];
  }
  if (!branches.some((b) => b.is_default))
    out.push({
      level: "error",
      message: `branching is not enabled on ${parent}`,
      fix: "Supabase dashboard, Project Settings, Integrations, GitHub: connect the repo with automatic branching on.",
    });
  const shared = branches.find((b) => b.name === config.sharedBranch);
  const finding = await githubFinding(
    branches.filter((b) => !b.is_default && b.project_ref !== parent),
    shared,
    supabase,
  );
  if (finding) out.push(finding);
  if (!shared) {
    out.push({
      level: "error",
      message: `no "${config.sharedBranch}" branch, the shared Preview database`,
      fix: "Run `supabase-worker-previews shared` to create it.",
    });
    return out;
  }
  if (shared.project_ref === parent || shared.is_default)
    out.push({
      level: "error",
      message: `"${config.sharedBranch}" is the production project itself`,
      fix: 'Set "sharedBranch" in supabase-worker-previews.json to another name, then run `supabase-worker-previews shared`.',
    });
  if (!shared.persistent)
    out.push({
      level: "warn",
      message: `"${config.sharedBranch}" is not persistent`,
      fix: "Run `supabase-worker-previews shared` to make it persistent.",
    });
  if (shared.git_branch !== config.trunk)
    out.push({
      level: "error",
      message: `"${config.sharedBranch}" tracks ${shared.git_branch ?? "no git branch"}, not ${config.trunk}`,
      fix: `Run \`supabase-worker-previews shared\` to point it at ${config.trunk}.`,
    });
  const vars = (readWranglerConfig(cwd)?.json.previews as { vars?: Record<string, string> } | undefined)
    ?.vars;
  const varsRef = projectRefOf(vars?.SUPABASE_URL);
  if (varsRef && varsRef !== shared.project_ref)
    out.push({
      level: "error",
      message: `previews.vars uses ${varsRef}, but "${config.sharedBranch}" is ${shared.project_ref}`,
      fix: "Run `supabase-worker-previews shared` and paste the values it prints into previews.vars.",
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
      "Branching without Git copies the schema without privileges, so signed-in reads 403",
    fix: "Connect the repo under Integrations, GitHub; if it is connected, push to the trunk and run doctor again.",
  };
}

function htmlFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".html")) : [];
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

export type Section = { title: string; findings: Finding[]; skipped?: string };

/** Local checks always; online checks when there is a token and a usable config. */
export async function doctor(
  overrides: Partial<Config>,
  supabase: SupabaseApi | undefined,
  cwd = process.cwd(),
): Promise<Section[]> {
  const local: Section = { title: "Local files", findings: [] };
  const online: Section = { title: "Supabase (online)", findings: [] };
  let config: Config | undefined;
  if (configFileIn(cwd) === LEGACY_CONFIG_FILE)
    local.findings.push({
      level: "warn",
      message: `${LEGACY_CONFIG_FILE} is the name from before 0.2.0`,
      fix: `Rename it to ${CONFIG_FILE}; the old name is still read for now.`,
    });
  if (existsSync(join(cwd, LEGACY_DOTENV_FILE)) && !existsSync(join(cwd, DOTENV_FILE)))
    local.findings.push({
      level: "warn",
      message: `${LEGACY_DOTENV_FILE} is the name from before 0.2.0`,
      fix: `Rename it to ${DOTENV_FILE}, and update .gitignore; the old name is still loaded for now.`,
    });
  try {
    config = loadConfig(overrides, cwd);
  } catch (err) {
    local.findings.push({ level: "error", message: (err as Error).message });
  }
  try {
    local.findings.push(
      ...checkLocal(
        config ?? { ...CONFIG_DEFAULTS, worker: "", supabaseProjectRef: "", ...defined(overrides) },
        cwd,
      ),
    );
  } catch (err) {
    local.findings.push({ level: "error", message: (err as Error).message });
  }
  if (!config) online.skipped = "skipped until the config above is fixed";
  else if (!supabase)
    online.skipped =
      "skipped: SUPABASE_ACCESS_TOKEN is not set. Add it to .env.supabase-worker-previews to also check branching, " +
      `the shared database and the GitHub integration (${TOKENS_URL}).`;
  else {
    online.title = `Supabase (online, project ${config.supabaseProjectRef})`;
    try {
      online.findings.push(...(await checkRemote(config, supabase, cwd)));
    } catch (err) {
      online.findings.push({ level: "error", message: (err as Error).message });
    }
  }
  return [local, online];
}

const MARKS = { ok: "✓", warn: "!", error: "✗" } as const;

export function formatReport(
  sections: Section[],
  s: Style = makeStyle(false),
): { text: string; pass: boolean } {
  const color = { ok: s.green, warn: s.yellow, error: s.red };
  const lines: string[] = [];
  for (const section of sections) {
    if (lines.length) lines.push("");
    lines.push(s.bold(section.title));
    for (const f of section.findings) {
      lines.push(`  ${color[f.level](MARKS[f.level])} ${f.message}`);
      if (f.fix && f.level !== "ok") lines.push(`    ${s.dim(`→ ${f.fix}`)}`);
    }
    if (section.skipped) lines.push(`  ${s.dim(`- ${section.skipped}`)}`);
  }
  const all = sections.flatMap((section) => section.findings);
  const errors = all.filter((f) => f.level === "error").length;
  const warnings = all.filter((f) => f.level === "warn").length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const skipped = sections.some((section) => section.skipped) ? " (online checks skipped)" : "";
  lines.push(
    "",
    errors
      ? s.red(
          `${plural(errors, "error")}, ${plural(warnings, "warning")}${skipped}. Fix the errors and run supabase-worker-previews doctor again.`,
        )
      : warnings
        ? s.yellow(`No errors, ${plural(warnings, "warning")}${skipped}.`)
        : s.green(`All checks passed${skipped}.`),
  );
  return { text: lines.join("\n"), pass: errors === 0 };
}
