import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseEnv } from "node:util";
import { parse as parseToml } from "smol-toml";
import { parseJsonc } from "./jsonc.js";
import { didYouMean } from "./suggest.js";

export const CONFIG_FILE = "supabase-worker-previews.json";
/** The name before 0.2.0, still read when the current one is absent. */
export const LEGACY_CONFIG_FILE = "swp.config.json";
export const DOTENV_FILE = ".env.supabase-worker-previews";
export const LEGACY_DOTENV_FILE = ".env.swp";

/** The only variables a dotenv file may set: anything else (NODE_OPTIONS, PATH) would reach wrangler. */
export const DOTENV_KEYS = [
  "SUPABASE_ACCESS_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "GITHUB_TOKEN",
  "SUPABASE_WORKER_PREVIEWS_DEBUG",
];

/** Copies the token variables from a dotenv file into `env`; variables already set there win. */
export function loadDotenv(path: string, env: Record<string, string | undefined> = process.env): string[] {
  const values = parseEnv(readFileSync(path, "utf8"));
  const loaded: string[] = [];
  for (const key of DOTENV_KEYS) {
    const value = values[key];
    if (value === undefined || env[key] !== undefined) continue;
    env[key] = value;
    loaded.push(key);
  }
  return loaded;
}

/** The config file to read in `cwd`: the current name, else the legacy one if only that exists. */
export function configFileIn(cwd = process.cwd()): string {
  return !existsSync(join(cwd, CONFIG_FILE)) && existsSync(join(cwd, LEGACY_CONFIG_FILE))
    ? LEGACY_CONFIG_FILE
    : CONFIG_FILE;
}
export const WRANGLER_FILES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];
/** What `supabase-worker-previews init` writes when it cannot find the project ref. */
export const PLACEHOLDER_REF = "<production project ref>";

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
  /** How Previews are named: after the raw git branch (Workers Builds), or `pr-<number>`. */
  previewName: "branch" | "pr";
  /** Which Supabase API keys to hand a Preview when a project has both kinds. */
  apiKeys: "legacy" | "new";
  /** `supabase-worker-previews pr` keeps one status comment on the PR. Default true. */
  prComment?: boolean;
  /** `supabase-worker-previews pr` records a GitHub deployment for the PR head. Default true. */
  githubDeployments?: boolean;
  /** GitHub environment of those deployments, shared by every PR; `{branch}` makes one per branch. Default "Preview". */
  deploymentEnvironment?: string;
};

export type WranglerConfig = { file: string; json: Record<string, unknown>; name?: string };

export const CONFIG_DEFAULTS = {
  trunk: "main",
  sharedBranch: "preview",
  supabaseDir: "supabase",
  isolatedLabel: "isolated-db",
  checkPath: "/",
  previewName: "branch" as const,
  apiKeys: "legacy" as const,
};

const CHOICES = { previewName: ["branch", "pr"], apiKeys: ["legacy", "new"] } as const;

const KEYS = [
  "$schema",
  "worker",
  "supabaseProjectRef",
  "trunk",
  "sharedBranch",
  "workersSubdomain",
  "supabaseDir",
  "isolatedLabel",
  "checkPath",
  "previewName",
  "apiKeys",
  "prComment",
  "githubDeployments",
  "deploymentEnvironment",
];

export function readWranglerConfig(cwd = process.cwd()): WranglerConfig | null {
  const file = WRANGLER_FILES.find((f) => existsSync(join(cwd, f)));
  if (!file) return null;
  const text = readFileSync(join(cwd, file), "utf8");
  let json: Record<string, unknown>;
  try {
    json = (file.endsWith(".toml") ? parseToml(text) : parseJsonc(text)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Cannot parse ${file}: ${(err as Error).message}`, { cause: err });
  }
  return { file, json, name: typeof json.name === "string" ? json.name : undefined };
}

export function loadConfig(overrides: Partial<Config> = {}, cwd = process.cwd()): Config {
  const name = configFileIn(cwd);
  const path = join(cwd, name);
  const exists = existsSync(path);
  const file = exists ? readConfigFile(path) : {};
  const wrangler = readWranglerConfig(cwd);
  const merged = { ...CONFIG_DEFAULTS, worker: wrangler?.name, ...file, ...defined(overrides) };
  if (!merged.supabaseProjectRef)
    throw new Error(
      exists
        ? `Set "supabaseProjectRef" (the production project) in ${name}`
        : `No ${name} in this directory. Run \`supabase-worker-previews init\` first, or pass --project-ref <ref>.`,
    );
  if (merged.supabaseProjectRef === PLACEHOLDER_REF)
    throw new Error(
      `"supabaseProjectRef" in ${name} is still ${PLACEHOLDER_REF}. ` +
        "Set it to the production project's ref, the <ref> in https://<ref>.supabase.co.",
    );
  if (!merged.worker)
    throw new Error(
      wrangler
        ? `${wrangler.file} has no "name"; add the Worker's name there or "worker" in ${name}`
        : `No ${WRANGLER_FILES.join(", ")} in this directory. Run supabase-worker-previews in the Worker's directory, or set "worker" in ${name}.`,
    );
  for (const [key, allowed] of Object.entries(CHOICES)) {
    const value = merged[key as keyof typeof CHOICES];
    if (!(allowed as readonly string[]).includes(value))
      throw new Error(`"${key}" in ${name} must be ${allowed.map((a) => `"${a}"`).join(" or ")}`);
  }
  return merged as Config;
}

function readConfigFile(path: string): Partial<Config> {
  const name = basename(path);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Cannot parse ${name}: ${(err as Error).message}`, { cause: err });
  }
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw new Error(`${name} must hold a JSON object`);
  for (const key of Object.keys(json)) {
    if (KEYS.includes(key)) continue;
    const guess = didYouMean(key, KEYS);
    throw new Error(
      `Unknown key "${key}" in ${name}.${guess ? ` Did you mean "${guess}"?` : ""} See the README for the keys.`,
    );
  }
  return json;
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

export function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
