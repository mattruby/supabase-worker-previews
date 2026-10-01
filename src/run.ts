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
        throw new Error(`${cmd} exited ${res.status}${tail ? `:\n${tail}` : ""}`);
      }
      return res.stdout ?? "";
    },
  };
}

export function parseArgs(argv: string[]): {
  positional: string[];
  flags: Record<string, string | true>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
    const next = argv[i + 1];
    if (v !== undefined) flags[k] = v;
    else if (next !== undefined && !next.startsWith("--")) flags[k] = argv[++i]!;
    else flags[k] = true;
  }
  return { positional, flags };
}

/** Exit code when usage is all there is to print: 0 when asked for help, 2 with no arguments at all. */
export function usageExitCode(
  positional: string[],
  flags: Record<string, string | true>,
): number | undefined {
  const command = positional[0];
  if (command === "help" || flags.help) return 0;
  if (!command) return 2;
  return undefined;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
