import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_FILE,
  configFileIn,
  migrationFiles,
  migrationsDir,
  PLACEHOLDER_REF,
  readWranglerConfig,
  WRANGLER_FILES,
} from "../config.js";
import { QUICKSTART_URL, TOKENS_URL } from "../http.js";
import { hasDefaultPrivileges } from "./doctor.js";

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
const WORKFLOW = ".github/workflows/supabase-previews.yml";

export type InitOptions = {
  supabaseProjectRef?: string;
  trunk?: string;
  /** Write the workflow that uses the published GitHub Action. */
  action?: boolean;
  dryRun?: boolean;
  log?: (line: string) => void;
};

/** `20260914000000_x.sql` minus one second, so a new migration sorts first. */
export function timestampBefore(file: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(file);
  if (!m) throw new Error(`${file} does not start with a YYYYMMDDHHMMSS timestamp`);
  const [, y, mo, d, h, mi, s] = m.map<number>(Number);
  return stamp(new Date(Date.UTC(y!, mo! - 1, d, h, mi, s) - 1000));
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function defaultTrunk(cwd: string): string {
  try {
    return execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .replace(/^origin\//, "");
  } catch {
    return "main";
  }
}

function hasProjectRef(json: string): boolean {
  try {
    const ref = (JSON.parse(json) as { supabaseProjectRef?: unknown }).supabaseProjectRef;
    return typeof ref === "string" && !!ref && ref !== PLACEHOLDER_REF;
  } catch {
    return true;
  }
}

function linkedProjectRef(cwd: string): string | undefined {
  const path = join(cwd, "supabase", ".temp", "project-ref");
  return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

export function init(options: InitOptions = {}, cwd = process.cwd()): void {
  const log = options.log ?? console.log;
  const wrangler = readWranglerConfig(cwd);
  if (!wrangler)
    throw new Error(
      `No ${WRANGLER_FILES.join(", ")} in this directory. Run supabase-worker-previews init in the Worker's directory.`,
    );
  if (!wrangler.name)
    throw new Error(
      `${wrangler.file} has no "name". Add the Worker's name, then run supabase-worker-previews init again.`,
    );
  const write = (path: string, content: string | Buffer) => {
    if (options.dryRun) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  if (options.dryRun) log("Dry run: nothing is written.\n");

  const configPath = join(cwd, configFileIn(cwd));
  let needsRef: boolean;
  if (existsSync(configPath)) {
    needsRef = !hasProjectRef(readFileSync(configPath, "utf8"));
    log(`- ${basename(configPath)} exists, left alone`);
  } else {
    const linked = linkedProjectRef(cwd);
    const ref = options.supabaseProjectRef ?? linked;
    needsRef = !ref;
    const config = {
      supabaseProjectRef: ref ?? PLACEHOLDER_REF,
      trunk: options.trunk ?? defaultTrunk(cwd),
    };
    write(configPath, JSON.stringify(config, null, 2) + "\n");
    const note = !ref
      ? "  (fill in supabaseProjectRef)"
      : ref === linked && !options.supabaseProjectRef
        ? "  (project ref from supabase link)"
        : "";
    log(`+ ${CONFIG_FILE}${note}`);
  }

  const config = { supabaseDir: "supabase" };
  const migrations = migrationFiles(config, cwd);
  const first = migrations[0];
  if (first && hasDefaultPrivileges(readFileSync(join(cwd, migrationsDir(config), first), "utf8"))) {
    log(`- ${first} already grants default privileges`);
  } else {
    const name = `${first ? timestampBefore(first) : stamp(new Date())}_api_default_privileges.sql`;
    write(join(cwd, migrationsDir(config), name), readFileSync(join(TEMPLATES, "default-privileges.sql")));
    log(`+ ${migrationsDir(config)}/${name}`);
    if (first)
      log(
        "  It is dated before your existing migrations. Production has not run it: apply it with\n" +
          `  \`supabase db push --include-all\`, or run the SQL once and \`supabase migration repair --status applied ${name.slice(0, 14)}\`.`,
      );
  }

  const workflowPath = join(cwd, WORKFLOW);
  if (existsSync(workflowPath)) log(`- ${WORKFLOW} exists, left alone`);
  else {
    write(
      workflowPath,
      readFileSync(
        join(TEMPLATES, options.action ? "supabase-previews-action.yml" : "supabase-previews.yml"),
      ),
    );
    log(`+ ${WORKFLOW}`);
    log(
      options.action
        ? "  It uses the published action, mattruby/supabase-worker-previews@v0."
        : "  It runs `npx supabase-worker-previews pr`; `npx supabase-worker-previews init --action` writes one that uses the published action instead.",
    );
  }

  const steps = [
    ...(needsRef
      ? [`Set "supabaseProjectRef" in ${CONFIG_FILE}: the <ref> in https://<ref>.supabase.co.`]
      : []),
    "Supabase dashboard, Project Settings, Integrations, GitHub: connect the repo, with\n" +
      'automatic branching on and "Deploy to production" off.',
    `In supabase/config.toml, add "https://*-${wrangler.name}.<subdomain>.workers.dev/**" to\n` +
      "[auth] additional_redirect_urls.",
    ...(wrangler.json.previews
      ? []
      : [`Add a "previews" block to ${wrangler.file}, redeclaring every binding the Worker uses.`]),
    "Put SUPABASE_ACCESS_TOKEN, CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in .env.supabase-worker-previews\n" +
      `(git-ignore it; scopes: ${TOKENS_URL}),\n` +
      "then run `npx supabase-worker-previews shared` and paste the previews.vars it prints.",
    "Wrap the Worker's default export:\n" +
      '  import { withSupabasePreviews } from "supabase-worker-previews";\n' +
      "  export default withSupabasePreviews(app);",
    "Workers Builds: turn on non-production branch builds, deploy command `npx wrangler preview`.",
    "GitHub repo, Settings, Secrets and variables, Actions: add the same three tokens.",
    "Run `npx supabase-worker-previews doctor` until it passes, then commit and open a PR.",
  ];
  log(`\nNext, by hand (the full guide: ${QUICKSTART_URL}):`);
  steps.forEach((step, i) => log(`  ${i + 1}. ${step.replace(/\n/g, "\n     ")}`));
}
