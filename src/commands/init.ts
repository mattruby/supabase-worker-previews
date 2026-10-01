import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, migrationFiles, migrationsDir, readWranglerConfig } from "../config.js";
import { hasDefaultPrivileges } from "./doctor.js";

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
const WORKFLOW = ".github/workflows/supabase-previews.yml";

export type InitOptions = { supabaseProjectRef?: string; trunk?: string; log?: (line: string) => void };

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

function linkedProjectRef(cwd: string): string | undefined {
  const path = join(cwd, "supabase", ".temp", "project-ref");
  return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

export function init(options: InitOptions = {}, cwd = process.cwd()): void {
  const log = options.log ?? console.log;
  const wrangler = readWranglerConfig(cwd);
  if (!wrangler?.name) throw new Error("Run `swp init` next to a wrangler config with a `name`");

  const configPath = join(cwd, CONFIG_FILE);
  if (existsSync(configPath)) log(`- ${CONFIG_FILE} exists, left alone`);
  else {
    const ref = options.supabaseProjectRef ?? linkedProjectRef(cwd);
    const config = {
      supabaseProjectRef: ref ?? "<production project ref>",
      trunk: options.trunk ?? defaultTrunk(cwd),
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    log(`+ ${CONFIG_FILE}${ref ? "" : "  (fill in supabaseProjectRef)"}`);
  }

  const config = { supabaseDir: "supabase" };
  const migrations = migrationFiles(config, cwd);
  const first = migrations[0];
  if (first && hasDefaultPrivileges(readFileSync(join(cwd, migrationsDir(config), first), "utf8"))) {
    log(`- ${first} already grants default privileges`);
  } else {
    const name = `${first ? timestampBefore(first) : stamp(new Date())}_api_default_privileges.sql`;
    mkdirSync(join(cwd, migrationsDir(config)), { recursive: true });
    writeFileSync(
      join(cwd, migrationsDir(config), name),
      readFileSync(join(TEMPLATES, "default-privileges.sql")),
    );
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
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, readFileSync(join(TEMPLATES, "supabase-previews.yml")));
    log(`+ ${WORKFLOW}`);
  }

  log(`
Then, by hand:
  1. Supabase dashboard, project settings, Integrations, GitHub: connect the repo,
     turn automatic branching on and "deploy to production" off.
  2. Add a "previews" block to ${wrangler.file}, redeclaring every binding the Worker uses.
  3. npx swp shared   (creates the shared Preview database and prints its previews.vars)
  4. Workers Builds: non-production branch builds on, with the deploy command
       npx wrangler preview
  5. GitHub Actions secrets: SUPABASE_ACCESS_TOKEN, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
  6. Wrap the Worker's default export with withSupabasePreviews(), then npx swp doctor.`);
}
