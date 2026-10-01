import { spawnSync } from "node:child_process";

export type ExecOptions = { env?: Record<string, string>; input?: string; captureStderr?: boolean };

export type Runner = {
  dryRun: boolean;
  log: (line: string) => void;
  /** Runs a command, or in dry-run mode only prints it. Throws on a non-zero exit. */
  exec: (cmd: string, args: string[], opts?: ExecOptions) => string;
};

export function makeRunner(dryRun: boolean, log: (line: string) => void = console.log): Runner {
  return {
    dryRun,
    log,
    exec(cmd, args, opts) {
      const shown = [cmd, ...args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(" ");
      if (dryRun) {
        log(`  $ ${shown}${opts?.input ? `  (stdin: ${opts.input.length} bytes)` : ""}`);
        return "";
      }
      log(`  $ ${shown}`);
      const res = spawnSync(cmd, args, {
        encoding: "utf8",
        env: { ...process.env, ...(opts?.env ?? {}) },
        input: opts?.input,
        stdio: [opts?.input ? "pipe" : "inherit", "pipe", opts?.captureStderr ? "pipe" : "inherit"],
        maxBuffer: 64 * 1024 * 1024,
      });
      if (res.error) throw res.error;
      if (res.status !== 0) {
        const tail = opts?.captureStderr ? (res.stderr ?? "").trim().split("\n").slice(-8).join("\n") : "";
        throw new Error(`\`${shown}\` exited ${res.status}${tail ? `:\n${tail}` : ""}`);
      }
      return res.stdout ?? "";
    },
  };
}

/**
 * `--flag value`, `--flag=value` and bare `--flag`. A flag in `booleans` never
 * takes the next argument, so `supabase-worker-previews --dry-run up` keeps `up` as the command.
 */
export function parseArgs(
  argv: string[],
  booleans: ReadonlySet<string> = new Set(),
): {
  positional: string[];
  flags: Record<string, string | true>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h") flags.help = true;
    else if (a === "-v") flags.version = true;
    else if (!a.startsWith("--")) positional.push(a);
    else {
      const eq = a.indexOf("=");
      const k = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const next = argv[i + 1];
      if (eq !== -1) flags[k] = a.slice(eq + 1);
      else if (!booleans.has(k) && next !== undefined && !next.startsWith("-")) flags[k] = argv[++i]!;
      else flags[k] = true;
    }
  }
  return { positional, flags };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
