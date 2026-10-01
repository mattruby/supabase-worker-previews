import type { PreviewRecord } from "../cloudflare.js";
import type { Config } from "../config.js";
import { previewName } from "../preview-name.js";
import type { Branch } from "../supabase.js";
import { assertIsolated, isDisposable, type Deps } from "./branches.js";

export type OpenPr = { number: number; head: string };
export type PrunePlan = { branches: Branch[]; previews: PreviewRecord[] };
/** What the repo says: its git branches, its open PRs, and the heads that only have closed PRs. */
export type RepoFacts = { branches: string[]; open: OpenPr[]; closedHeads: string[] };

async function github<T>(path: string, token: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(`https://api.github.com/repos/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function allPages<T>(path: string, token: string, fetchImpl: typeof fetch): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page += 1) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await github<T[]>(`${path}${sep}per_page=100&page=${page}`, token, fetchImpl);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

export async function openPullRequests(
  repo: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<OpenPr[]> {
  const prs = await allPages<{ number: number; head: { ref: string } }>(
    `${repo}/pulls?state=open`,
    token,
    fetchImpl,
  );
  return prs.map((p) => ({ number: p.number, head: p.head.ref }));
}

export async function repoBranches(repo: string, token: string, fetchImpl: typeof fetch): Promise<string[]> {
  return (await allPages<{ name: string }>(`${repo}/branches`, token, fetchImpl)).map((b) => b.name);
}

async function hasClosedPr(repo: string, ref: string, token: string, fetchImpl: typeof fetch) {
  const owner = repo.split("/")[0];
  const head = encodeURIComponent(`${owner}:${ref}`);
  return (
    (await github<unknown[]>(`${repo}/pulls?state=closed&head=${head}&per_page=1`, token, fetchImpl)).length >
    0
  );
}

function slugOf(branch: string): string | undefined {
  try {
    return previewName(branch);
  } catch {
    return undefined;
  }
}

/**
 * Leftovers. A disposable Supabase branch whose git branch is gone, or has a
 * closed PR and no open one. A Preview whose git branch is gone, or with
 * previewName "pr", a pr-<n> whose PR is not open. Never the trunk's Preview.
 */
export function planPrune(
  branches: Branch[],
  previews: PreviewRecord[],
  facts: RepoFacts,
  config: Config,
): PrunePlan {
  const existing = new Set(facts.branches);
  const existingSlugs = new Set(facts.branches.map(slugOf).filter((s) => s !== undefined));
  const openHeads = new Set(facts.open.map((p) => p.head));
  const closedHeads = new Set(facts.closedHeads);
  const numbers = new Set(facts.open.map((p) => p.number));
  const isTrunk = (p: PreviewRecord) => p.name === config.trunk || p.slug === slugOf(config.trunk);
  return {
    branches: branches.filter(
      (b) =>
        isDisposable(b, config) &&
        !!b.git_branch &&
        !openHeads.has(b.git_branch) &&
        (!existing.has(b.git_branch) || closedHeads.has(b.git_branch)),
    ),
    previews: previews.filter((p) => {
      if (isTrunk(p)) return false;
      if (config.previewName === "pr") {
        const n = /^pr-(\d+)$/.exec(p.name)?.[1];
        return n !== undefined && !numbers.has(Number(n));
      }
      return !existing.has(p.name) && !existingSlugs.has(p.slug);
    }),
  };
}

/** Prints the leftovers; deletes them only with `yes`. */
export async function prune(
  deps: Deps & { githubToken: string; repo: string; yes: boolean },
): Promise<PrunePlan> {
  const { config, runner } = deps;
  const { repo, githubToken: token, fetchImpl } = deps;
  const open = await openPullRequests(repo, token, fetchImpl);
  const existing = await repoBranches(repo, token, fetchImpl);
  const supabaseBranches = await deps.supabase.listBranches(config.supabaseProjectRef);
  const openHeads = new Set(open.map((p) => p.head));
  const closedHeads: string[] = [];
  for (const gitBranch of new Set(
    supabaseBranches.filter((b) => isDisposable(b, config)).map((b) => b.git_branch),
  )) {
    if (!gitBranch || openHeads.has(gitBranch) || !existing.includes(gitBranch)) continue;
    if (await hasClosedPr(repo, gitBranch, token, fetchImpl)) closedHeads.push(gitBranch);
  }
  const plan = planPrune(
    supabaseBranches,
    await deps.cloudflare.listPreviews(),
    { branches: existing, open, closedHeads },
    config,
  );
  runner.log(`${repo} has ${existing.length} branches and ${open.length} open PRs`);
  for (const b of plan.branches)
    runner.log(`  Supabase branch ${b.name} (${b.project_ref}), git branch ${b.git_branch}`);
  for (const p of plan.previews) runner.log(`  Preview ${p.name}`);
  if (!plan.branches.length && !plan.previews.length) {
    runner.log("Nothing to prune");
    return plan;
  }
  if (!deps.yes || runner.dryRun) {
    runner.log("Run again with --yes to delete these");
    return plan;
  }
  for (const b of plan.branches) {
    assertIsolated(b, config.supabaseProjectRef);
    await deps.supabase.deleteBranch(b.project_ref);
    runner.log(`  deleted Supabase branch ${b.name}`);
  }
  for (const p of plan.previews) {
    deps.cloudflare.deletePreview(p.name);
    runner.log(`  deleted Preview ${p.name}`);
  }
  return plan;
}
