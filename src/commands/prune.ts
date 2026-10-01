import type { PreviewRecord } from "../cloudflare.js";
import type { Config } from "../config.js";
import { previewName } from "../preview-name.js";
import type { Branch } from "../supabase.js";
import { assertIsolated, isDisposable, type Deps } from "./branches.js";

export type OpenPr = { number: number; head: string };
export type PrunePlan = { branches: Branch[]; previews: PreviewRecord[] };

export async function openPullRequests(
  repo: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<OpenPr[]> {
  const prs: OpenPr[] = [];
  for (let page = 1; ; page += 1) {
    const res = await fetchImpl(
      `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100&page=${page}`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
    );
    if (!res.ok) throw new Error(`GitHub open PRs of ${repo}: ${res.status} ${await res.text()}`);
    const batch = (await res.json()) as { number: number; head: { ref: string } }[];
    prs.push(...batch.map((p) => ({ number: p.number, head: p.head.ref })));
    if (batch.length < 100) return prs;
  }
}

function slugOf(branch: string): string | undefined {
  try {
    return previewName(branch);
  } catch {
    return undefined;
  }
}

/** Leftovers: disposable branches and Previews whose git branch (or PR) has no open PR. Never the trunk's. */
export function planPrune(
  branches: Branch[],
  previews: PreviewRecord[],
  open: OpenPr[],
  config: Config,
): PrunePlan {
  const heads = new Set(open.map((p) => p.head));
  const numbers = new Set(open.map((p) => p.number));
  const headSlugs = new Set([...heads].map(slugOf).filter((s) => s !== undefined));
  const isTrunk = (p: PreviewRecord) => p.name === config.trunk || p.slug === slugOf(config.trunk);
  return {
    branches: branches.filter((b) => isDisposable(b, config) && !!b.git_branch && !heads.has(b.git_branch)),
    previews: previews.filter((p) => {
      if (isTrunk(p)) return false;
      if (config.previewName === "pr") {
        const n = /^pr-(\d+)$/.exec(p.name)?.[1];
        return n !== undefined && !numbers.has(Number(n));
      }
      return !heads.has(p.name) && !headSlugs.has(p.slug);
    }),
  };
}

/** Prints what has no open PR; deletes it only with `yes`. */
export async function prune(
  deps: Deps & { githubToken: string; repo: string; yes: boolean },
): Promise<PrunePlan> {
  const { config, runner } = deps;
  const open = await openPullRequests(deps.repo, deps.githubToken, deps.fetchImpl);
  const plan = planPrune(
    await deps.supabase.listBranches(config.supabaseProjectRef),
    await deps.cloudflare.listPreviews(),
    open,
    config,
  );
  runner.log(`${deps.repo} has ${open.length} open PRs`);
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
