import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
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
};

export type WranglerConfig = { file: string; json: Record<string, unknown>; name?: string };

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
  let json: Record<string, unknown>;
  try {
    json = (file.endsWith(".toml") ? parseToml(text) : parseJsonc(text)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Cannot parse ${file}: ${(err as Error).message}`);
  }
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
