import { readFileSync } from "node:fs";
import type { Config } from "../config.js";
import { Feedback, type FeedbackDeps } from "../feedback.js";
import { check, down, release, up } from "./branches.js";

export type PullRequestEvent = {
  action: string;
  number: number;
  pull_request: {
    head: { ref: string; sha: string; repo?: { full_name: string } | null };
    labels: { name: string }[];
  };
  repository: { full_name: string };
};

export function readEvent(path = process.env.GITHUB_EVENT_PATH): PullRequestEvent {
  if (!path) throw new Error("GITHUB_EVENT_PATH is not set; `swp pr` runs inside a pull_request workflow");
  const event = JSON.parse(readFileSync(path, "utf8")) as PullRequestEvent;
  if (!event.pull_request) throw new Error("`swp pr` needs a pull_request event");
  return event;
}

export const PR_ENV = [
  "SUPABASE_ACCESS_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "GITHUB_TOKEN",
];

export type Skip = { level: "notice" | "warning" | "error"; message: string };

/**
 * A fork PR, or a bot PR without secrets (Dependabot gets none), is skipped with an annotation.
 * Anyone else's PR without secrets fails, so a misconfigured repo never shows a green check.
 */
export function skipReason(
  event: PullRequestEvent,
  env: Record<string, string | undefined> = process.env,
): Skip | null {
  const head = event.pull_request.head.repo;
  if (head !== undefined && head?.full_name !== event.repository.full_name)
    return {
      level: "notice",
      message: `swp pr skipped PR #${event.number}: it comes from ${head ? `the fork ${head.full_name}` : "a deleted fork"}, and GitHub Actions gives fork PRs no secrets`,
    };
  const missing = PR_ENV.filter((name) => !env[name]);
  if (missing.length) {
    const bot = env.GITHUB_ACTOR?.endsWith("[bot]") ?? false;
    return {
      level: bot ? "warning" : "error",
      message: `swp pr ${bot ? "skipped" : "cannot check"} PR #${event.number}: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} empty; add ${missing.length === 1 ? "it" : "them"} to the repository's Actions secrets`,
    };
  }
  return null;
}

export function annotation(skip: Skip): string {
  return `::${skip.level}::${skip.message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`;
}

export async function changedFiles(
  event: PullRequestEvent,
  token: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const files: string[] = [];
  for (let page = 1; ; page += 1) {
    const res = await fetchImpl(
      `https://api.github.com/repos/${event.repository.full_name}/pulls/${event.number}/files?per_page=100&page=${page}`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
    );
    if (!res.ok) throw new Error(`GitHub PR files: ${res.status} ${await res.text()}`);
    const batch = (await res.json()) as { filename: string; previous_filename?: string }[];
    for (const f of batch) files.push(f.filename, ...(f.previous_filename ? [f.previous_filename] : []));
    if (batch.length < 100) return files;
  }
}

export function needsIsolatedDb(event: PullRequestEvent, files: string[], config: Config): boolean {
  if (event.pull_request.labels.some((l) => l.name === config.isolatedLabel)) return true;
  const dir = config.supabaseDir.replace(/\/+$/, "") + "/";
  return files.some((f) => f.startsWith(dir));
}

/** One entry point for a pull_request workflow: clean up on close, otherwise point and prove. */
export async function pr(event: PullRequestEvent, deps: FeedbackDeps): Promise<void> {
  const branch = event.pull_request.head.ref;
  const feedback = new Feedback(event, deps);
  const files = await changedFiles(event, deps.githubToken, deps.fetchImpl);
  const isolated = needsIsolatedDb(event, files, deps.config);
  if (event.action === "closed") return feedback.close(() => down(branch, deps, event.number), isolated);
  deps.runner.log(
    `PR #${event.number} (${branch}): ${isolated ? "its own database" : `the shared "${deps.config.sharedBranch}" database`}`,
  );
  await feedback.run(isolated, async () => {
    if (isolated) await up(branch, deps, event.number);
    else await release(branch, deps, event.number);
    await check(branch, isolated, deps, event.number);
  });
}
