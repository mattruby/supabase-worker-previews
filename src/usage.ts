import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_URL, TOKENS_URL } from "./http.js";
import { parseArgs } from "./run.js";
import { didYouMean } from "./suggest.js";
import { makeStyle, type Style } from "./style.js";

type Flag = { name: string; value?: string; help: string };

export type CommandName = "init" | "doctor" | "shared" | "up" | "check" | "down" | "pr" | "prune";

type Command = {
  name: CommandName;
  group: "Set up" | "Per branch" | "In CI";
  args: string;
  summary: string;
  details: string;
  flags: Flag[];
  env: string[];
  /** The variables `--dry-run` still needs, because the dry run reads live state. */
  dryRunEnv: string[];
  examples: string[];
};

const TOKENS = ["SUPABASE_ACCESS_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];
const WITH_GITHUB = [...TOKENS, "GITHUB_TOKEN"];

const DRY_RUN: Flag = { name: "dry-run", help: "Print the plan; change nothing" };
const OVERRIDES: Flag[] = [
  {
    name: "dotenv",
    value: "<path>",
    help: "Load tokens from this file (default: .env.supabase-worker-previews when present)",
  },
  { name: "worker", value: "<name>", help: 'Worker name (default: "name" in the wrangler config)' },
  {
    name: "project-ref",
    value: "<ref>",
    help: "Production project ref (default: supabase-worker-previews.json)",
  },
  {
    name: "trunk",
    value: "<branch>",
    help: "Branch the shared database tracks (default: supabase-worker-previews.json)",
  },
];
const BRANCH: Flag[] = [
  { name: "branch", value: "<b>", help: "Git branch (default: the current one, or the CI branch)" },
  { name: "pr", value: "<n>", help: 'Pull request number; needed when previewName is "pr"' },
];
const HELP: Flag[] = [
  { name: "help", help: "Show help" },
  { name: "version", help: "Print the version" },
];

export const COMMANDS: Command[] = [
  {
    name: "init",
    group: "Set up",
    args: "[--project-ref <ref>] [--trunk <branch>] [--action]",
    summary: "Scaffold supabase-worker-previews.json, the grants migration and the PR workflow",
    details:
      "Writes supabase-worker-previews.json, a first migration that grants the API roles default privileges, and\n" +
      ".github/workflows/supabase-previews.yml. Never overwrites a file; run it again safely.",
    flags: [
      { name: "project-ref", value: "<ref>", help: "Production project ref (default: from `supabase link`)" },
      {
        name: "trunk",
        value: "<branch>",
        help: "Branch the shared database tracks (default: origin/HEAD, else main)",
      },
      {
        name: "action",
        help: "Write a workflow that uses the published GitHub Action instead of npx supabase-worker-previews",
      },
      { ...DRY_RUN, help: "Print what it would write; write nothing" },
    ],
    env: [],
    dryRunEnv: [],
    examples: [
      "supabase-worker-previews init --project-ref abcdefghijklmnopqrst",
      "supabase-worker-previews init --action",
    ],
  },
  {
    name: "doctor",
    group: "Set up",
    args: "",
    summary: "Check the setup: local files, and the Supabase project when a token is set",
    details:
      "Checks wrangler, the previews block, bindings, static HTML, the grants migration and auth\n" +
      "redirects. With SUPABASE_ACCESS_TOKEN it also checks branching, the shared Preview database\n" +
      "and the GitHub integration. Exits 1 when any check fails.",
    flags: OVERRIDES,
    env: [],
    dryRunEnv: [],
    examples: ["supabase-worker-previews doctor"],
  },
  {
    name: "shared",
    group: "Set up",
    args: "",
    summary: "Create or repair the shared Preview database; prints its previews.vars",
    details:
      "Makes a persistent Supabase branch that tracks the trunk, waits for its migrations, sets its\n" +
      "auth redirects, stores its secret key in the Preview base config, and prints the values to\n" +
      "paste under previews.vars in the wrangler config.",
    flags: [DRY_RUN, ...OVERRIDES],
    env: TOKENS,
    dryRunEnv: ["SUPABASE_ACCESS_TOKEN"],
    examples: ["supabase-worker-previews shared --dry-run", "supabase-worker-previews shared"],
  },
  {
    name: "up",
    group: "Per branch",
    args: "[--branch <b>] [--pr <n>]",
    summary: "Give a branch's Preview its own database",
    details:
      "Finds or creates the Supabase branch for the git branch, waits for its migrations, and points\n" +
      "the branch's Preview at it with one SUPABASE_OVERRIDE secret.",
    flags: [...BRANCH, DRY_RUN, ...OVERRIDES],
    env: TOKENS,
    dryRunEnv: [],
    examples: ["supabase-worker-previews up --branch feat/notes --dry-run"],
  },
  {
    name: "check",
    group: "Per branch",
    args: "[--branch <b>] [--pr <n>] [--isolated]",
    summary: "Fail unless a branch's Preview serves the right database",
    details:
      "Reads which database the deployed Preview serves and retries for up to 15 minutes while it\n" +
      "deploys. Fails at once if it serves production.",
    flags: [
      ...BRANCH,
      { name: "isolated", help: "Expect the branch's own database, not the shared one" },
      DRY_RUN,
      ...OVERRIDES,
    ],
    env: TOKENS,
    dryRunEnv: [],
    examples: ["supabase-worker-previews check --branch feat/notes --isolated"],
  },
  {
    name: "down",
    group: "Per branch",
    args: "[--branch <b>] [--pr <n>]",
    summary: "Delete a branch's Preview and its own database",
    details: "Never deletes the production project, the shared database or a persistent branch.",
    flags: [...BRANCH, DRY_RUN, ...OVERRIDES],
    env: TOKENS,
    dryRunEnv: TOKENS,
    examples: ["supabase-worker-previews down --branch feat/notes --dry-run"],
  },
  {
    name: "pr",
    group: "In CI",
    args: "[--no-comment] [--no-deployments]",
    summary: "Run up, check and down for a pull_request workflow, and report on the PR",
    details:
      "Reads the pull_request event from GITHUB_EVENT_PATH. On close it runs down; otherwise it gives\n" +
      "the Preview its own database when the PR changes supabase/ (or has the isolated-db label),\n" +
      "then checks it. Keeps one status comment and a GitHub deployment on the PR.",
    flags: [
      { name: "no-comment", help: "Skip the PR status comment" },
      { name: "no-deployments", help: "Skip the GitHub deployment" },
      DRY_RUN,
      ...OVERRIDES,
    ],
    env: WITH_GITHUB,
    dryRunEnv: WITH_GITHUB,
    examples: ["supabase-worker-previews pr"],
  },
  {
    name: "prune",
    group: "In CI",
    args: "[--repo <owner/name>] [--yes]",
    summary: "List leftovers of deleted branches and closed PRs; --yes deletes them",
    details: "Lists Supabase branches and Previews whose git branch is gone or whose PR is closed.",
    flags: [
      {
        name: "repo",
        value: "<owner/name>",
        help: "GitHub repo (default: GITHUB_REPOSITORY, else the origin remote)",
      },
      { name: "yes", help: "Delete what it lists" },
      DRY_RUN,
      ...OVERRIDES,
    ],
    env: WITH_GITHUB,
    dryRunEnv: WITH_GITHUB,
    examples: ["supabase-worker-previews prune", "supabase-worker-previews prune --yes"],
  },
];

const ALL_FLAGS = [...COMMANDS.flatMap((c) => c.flags), ...HELP];
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(
  ALL_FLAGS.filter((f) => !f.value).map((f) => f.name),
);

export function command(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function version(): string {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
}

function flagTable(flags: Flag[], s: Style): string[] {
  const label = (f: Flag) =>
    (f.name === "help" ? "-h, " : f.name === "version" ? "-v, " : "") +
    `--${f.name}${f.value ? ` ${f.value}` : ""}`;
  const width = Math.max(...flags.map((f) => label(f).length));
  return flags.map((f) => `  ${s.cyan(label(f).padEnd(width))}  ${f.help}`);
}

export function mainHelp(s: Style = makeStyle(false)): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const groups = [...new Set(COMMANDS.map((c) => c.group))].flatMap((group) => [
    "",
    s.bold(group),
    ...COMMANDS.filter((c) => c.group === group).map(
      (c) => `  ${s.cyan(c.name.padEnd(width))}  ${c.summary}`,
    ),
  ]);
  return [
    `${s.bold("supabase-worker-previews")} ${version()}: branch previews for Cloudflare Workers on Supabase branching`,
    "",
    `${s.bold("Usage:")} supabase-worker-previews <command> [flags]`,
    ...groups,
    "",
    s.bold("Common flags"),
    ...flagTable([DRY_RUN, ...OVERRIDES, ...HELP], s),
    "",
    s.bold("Environment"),
    `  ${TOKENS.join(", ")}, and GITHUB_TOKEN for pr and prune.`,
    `  Where to get them: ${TOKENS_URL}`,
    "",
    s.bold("Examples"),
    "  npx supabase-worker-previews init --project-ref abcdefghijklmnopqrst",
    "  npx supabase-worker-previews doctor",
    "  npx supabase-worker-previews shared --dry-run",
    "",
    `Run ${s.cyan("supabase-worker-previews <command> --help")} for one command. Docs: ${DOCS_URL}`,
  ].join("\n");
}

export function commandHelp(c: Command, s: Style = makeStyle(false)): string {
  return [
    `${s.bold(`supabase-worker-previews ${c.name}`)}: ${c.summary.charAt(0).toLowerCase()}${c.summary.slice(1)}`,
    "",
    `${s.bold("Usage:")} supabase-worker-previews ${c.name}${c.args ? ` ${c.args}` : ""}`,
    "",
    c.details,
    "",
    s.bold("Flags"),
    ...flagTable([...c.flags, HELP[0]!], s),
    ...(c.env.length ? ["", `${s.bold("Needs:")} ${c.env.join(", ")} (${TOKENS_URL})`] : []),
    "",
    s.bold("Examples"),
    ...c.examples.map((e) => `  ${e}`),
    "",
    `Docs: ${DOCS_URL}`,
  ].join("\n");
}

export type Invocation =
  | { kind: "help"; text: string; code: 0 | 2 }
  | { kind: "version" }
  | { kind: "error"; message: string }
  | { kind: "run"; command: CommandName; flags: Record<string, string | true> };

/** What the arguments ask for, or a usage error that says how to fix them. */
export function resolveInvocation(argv: string[], s: Style = makeStyle(false)): Invocation {
  const { positional, flags } = parseArgs(argv, BOOLEAN_FLAGS);
  if (flags.version) return { kind: "version" };
  const [name, ...rest] = positional;
  if (name === "help") {
    if (!rest[0]) return { kind: "help", text: mainHelp(s), code: 0 };
    const c = command(rest[0]);
    return c ? { kind: "help", text: commandHelp(c, s), code: 0 } : unknownCommand(rest[0]);
  }
  if (!name) return { kind: "help", text: mainHelp(s), code: flags.help ? 0 : 2 };
  const c = command(name);
  if (!c) return unknownCommand(name);
  if (flags.help) return { kind: "help", text: commandHelp(c, s), code: 0 };

  if (rest.length) {
    const hint = BRANCH.every((f) => c.flags.includes(f))
      ? ` To name a branch, use --branch ${rest[0]}.`
      : "";
    return usageError(`${c.name} takes no arguments, but got "${rest.join(" ")}".${hint}`, c.name);
  }
  const known = [...c.flags, ...HELP].map((f) => f.name);
  for (const [key, value] of Object.entries(flags)) {
    const flag = c.flags.find((f) => f.name === key);
    if (!flag) {
      const elsewhere = ALL_FLAGS.some((f) => f.name === key);
      const guess = key === "env-file" ? "dotenv" : didYouMean(key, known);
      return usageError(
        elsewhere
          ? `${c.name} does not take --${key}.`
          : `Unknown flag --${key}.${guess ? ` Did you mean --${guess}?` : ""}`,
        c.name,
      );
    }
    if (flag.value && (value === true || value === ""))
      return usageError(`--${key} needs a value: --${key} ${flag.value}`, c.name);
    if (!flag.value && value !== true) return usageError(`--${key} takes no value.`, c.name);
  }
  return { kind: "run", command: c.name, flags };
}

function unknownCommand(name: string): Invocation {
  const guess = didYouMean(
    name,
    COMMANDS.map((c) => c.name),
  );
  return {
    kind: "error",
    message: `Unknown command "${name}".${guess ? ` Did you mean "supabase-worker-previews ${guess}"?` : ""}\nRun supabase-worker-previews --help to see every command.`,
  };
}

function usageError(message: string, name: CommandName): Invocation {
  return { kind: "error", message: `${message}\nRun supabase-worker-previews ${name} --help for its usage.` };
}

const ENV_SOURCES: Record<string, string> = {
  SUPABASE_ACCESS_TOKEN: "https://supabase.com/dashboard/account/tokens (organization-scoped)",
  CLOUDFLARE_API_TOKEN: "https://dash.cloudflare.com/profile/api-tokens (Workers Scripts: Edit)",
  CLOUDFLARE_ACCOUNT_ID: "Cloudflare dashboard, Workers and Pages, Account details",
  GITHUB_TOKEN: "`gh auth token` locally; ${{ github.token }} in Actions",
};

/** Names every variable the command needs and lacks, with where to get each; undefined when none is missing. */
export function missingEnvMessage(
  name: CommandName,
  dryRun: boolean,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const c = command(name)!;
  const missing = (dryRun ? c.dryRunEnv : c.env).filter((v) => !env[v]);
  if (!missing.length) return undefined;
  const width = Math.max(...missing.map((v) => v.length));
  return [
    `${name}${dryRun ? " --dry-run" : ""} needs ${missing.length === 1 ? "this variable" : "these variables"}, not set:`,
    ...missing.map((v) => `  ${v.padEnd(width)}  ${ENV_SOURCES[v]}`),
    `Put ${missing.length === 1 ? "it" : "them"} in .env.supabase-worker-previews (git-ignore it) or the environment. Scopes: ${TOKENS_URL}`,
  ].join("\n");
}

/** One line for the user: the message, and for a network failure the host and the system error. */
export function formatError(
  err: unknown,
  debug = !!(process.env.SUPABASE_WORKER_PREVIEWS_DEBUG || process.env.SWP_DEBUG),
): string {
  if (!(err instanceof Error)) return String(err);
  if (debug && err.stack) return err.stack;
  const cause = err.cause as { code?: string; hostname?: string; message?: string } | undefined;
  if (err.message === "fetch failed" && cause)
    return `network error${cause.hostname ? ` reaching ${cause.hostname}` : ""}: ${cause.code ?? cause.message ?? "unknown"}. Check the connection and try again.`;
  return err.message;
}
