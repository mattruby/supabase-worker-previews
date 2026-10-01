import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc } from "./jsonc.js";

export const CONFIG_FILE = "swp.config.json";
const WRANGLER_FILES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

export type Config = {
  /** Worker name; defaults to `name` in the wrangler config. */
  worker: string;
  /** The parent (production) Supabase project. Previews must never serve it. */
  supabaseProjectRef: string;
  /** Git branch the shared Preview database tracks. */
  trunk: string;
  /** Name of the persistent Supabase branch every Preview shares by default. */
  sharedBranch: string;
  /** The account's workers.dev subdomain; looked up through the API when absent. */
  workersSubdomain?: string;
  supabaseDir: string;
  /** PR label that asks for an isolated database without a schema change. */
  isolatedLabel: string;
  /** Path `check` fetches when the Worker does not serve the identity route. */
  checkPath: string;
  /** `swp pr` keeps one status comment on the PR. Default true. */
  prComment?: boolean;
  /** `swp pr` records a GitHub deployment for the PR head. Default true. */
  githubDeployments?: boolean;
  /** GitHub environment of those deployments, shared by every PR; `{branch}` makes one per branch. Default "Preview". */
  deploymentEnvironment?: string;
};

export type WranglerConfig = { file: string; json: Record<string, unknown> | null; name?: string };

const DEFAULTS = {
  trunk: "main",
  sharedBranch: "preview",
  supabaseDir: "supabase",
  isolatedLabel: "isolated-db",
  checkPath: "/",
};

export function readWranglerConfig(cwd = process.cwd()): WranglerConfig | null {
  const file = WRANGLER_FILES.find((f) => existsSync(join(cwd, f)));
  if (!file) return null;
  const text = readFileSync(join(cwd, file), "utf8");
  if (file.endsWith(".toml")) {
    return { file, json: null, name: /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1] };
  }
  const json = parseJsonc(text) as Record<string, unknown>;
  return { file, json, name: typeof json.name === "string" ? json.name : undefined };
}

export function loadConfig(overrides: Partial<Config> = {}, cwd = process.cwd()): Config {
  const path = join(cwd, CONFIG_FILE);
  const file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<Config>) : {};
  const wrangler = readWranglerConfig(cwd);
  const merged = { ...DEFAULTS, worker: wrangler?.name, ...file, ...defined(overrides) };
  if (!merged.worker)
    throw new Error(`No worker name: set "worker" in ${CONFIG_FILE} or "name" in the wrangler config`);
  if (!merged.supabaseProjectRef)
    throw new Error(`Set "supabaseProjectRef" (the production project) in ${CONFIG_FILE}`);
  return merged as Config;
}

export function migrationsDir(config: Pick<Config, "supabaseDir">): string {
  return join(config.supabaseDir, "migrations");
}

export function migrationFiles(config: Pick<Config, "supabaseDir">, cwd = process.cwd()): string[] {
  const dir = join(cwd, migrationsDir(config));
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort()
    : [];
}

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
