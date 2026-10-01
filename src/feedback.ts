import { branchFor, previewKey, type Deps } from "./commands/branches.js";
import type { PullRequestEvent } from "./commands/pr.js";
import { GitHubApi, type Deployment } from "./github.js";

export const COMMENT_MARKER = "<!-- supabase-worker-previews -->";
const PAYLOAD_KEY = "swpPullRequest";

export type Database = { kind: "shared" | "own"; name: string; ref?: string };

export type CommentState = {
  phase: "checking" | "passed" | "failed" | "removed" | "cleanup-failed";
  worker: string;
  sha: string;
  commitUrl: string;
  dashboardUrl: string;
  updated: Date;
  previewUrl?: string;
  database?: Database;
  error?: string;
  runUrl?: string;
};

const STATUS: Record<CommentState["phase"], string> = {
  checking: "Checking",
  passed: "**Passed**",
  failed: "**Failed**",
  removed: "Removed",
  "cleanup-failed": "**Cleanup failed**",
};

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (text: string) => `\`${cell(text)}\``;

function databaseCell(db: Database | undefined, dashboardUrl: string): string {
  if (!db) return "Unknown";
  const name = `[${code(db.name)}](${dashboardUrl})`;
  const ref = db.ref ? ` (${code(db.ref)})` : "";
  return db.kind === "shared" ? `Shared ${name}${ref}` : `Own branch ${name}${ref}`;
}

function reason(error: string): string {
  const text = error.length > 1500 ? `${error.slice(0, 1500)}...` : error;
  return text.includes("\n") ? `\n\n\`\`\`\n${text}\n\`\`\`` : ` ${text}`;
}

export function renderComment(s: CommentState): string {
  const commit = `[${code(s.sha.slice(0, 7))}](${s.commitUrl})`;
  const updated = s.updated.toISOString().slice(0, 16).replace("T", " ");
  const status = s.runUrl ? `${STATUS[s.phase]} ([logs](${s.runUrl}))` : STATUS[s.phase];
  const lines = [COMMENT_MARKER, `**Supabase Worker Preview** for ${code(s.worker)}`, ""];
  if (s.phase === "removed") {
    lines.push(
      s.database?.kind === "own"
        ? `The Preview and its own database ${code(s.database.name)} were removed when this PR closed.`
        : `The Preview was removed when this PR closed. The shared database stays.`,
      "",
      `<sub>Last commit ${commit}, ${updated} UTC</sub>`,
    );
    return lines.join("\n");
  }
  const preview = s.previewUrl ? `[Visit Preview](${s.previewUrl})` : "Not deployed yet";
  lines.push(
    "| Status | Preview | Database | Commit | Updated (UTC) |",
    "| :-- | :-- | :-- | :-- | :-- |",
    `| ${status} | ${preview} | ${databaseCell(s.database, s.dashboardUrl)} | ${commit} | ${updated} |`,
  );
  if (s.error) lines.push("", `**Reason:**${reason(s.error)}`);
  return lines.join("\n");
}

/** `::warning::` lines end at a newline, so GitHub's escapes keep a multi-line message whole. */
export function warning(message: string): string {
  return `::warning::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`;
}

export type FeedbackDeps = Deps & {
  githubToken: string;
  github?: GitHubApi;
  env?: Record<string, string | undefined>;
  clock?: () => Date;
};

/**
 * The PR comment and GitHub deployment for one `swp pr` run. Any GitHub API
 * failure becomes a warning; only the wrapped database work decides the job.
 */
export class Feedback {
  private github: GitHubApi;
  private commentOn: boolean;
  private deploymentsOn: boolean;
  private commentId?: number;
  private branch: string;
  private sha: string;
  private environment: string;
  private server: string;
  private runUrl?: string;

  constructor(
    private event: PullRequestEvent,
    private deps: FeedbackDeps,
  ) {
    const env = deps.env ?? process.env;
    this.github = deps.github ?? new GitHubApi(deps.githubToken, event.repository.full_name, deps.fetchImpl);
    this.commentOn = deps.config.prComment !== false && !deps.runner.dryRun;
    this.deploymentsOn = deps.config.githubDeployments !== false && !deps.runner.dryRun;
    this.branch = event.pull_request.head.ref;
    this.sha = event.pull_request.head.sha;
    this.environment = (deps.config.deploymentEnvironment ?? "Preview").replaceAll("{branch}", this.branch);
    this.server = env.GITHUB_SERVER_URL ?? "https://github.com";
    if (env.GITHUB_RUN_ID)
      this.runUrl = `${this.server}/${event.repository.full_name}/actions/runs/${env.GITHUB_RUN_ID}`;
  }

  /** Reports on `work` (up and check) from start to finish, and rethrows its error. */
  async run(isolated: boolean, work: () => Promise<void>): Promise<void> {
    if (!this.commentOn && !this.deploymentsOn) return work();
    await this.comment({
      phase: "checking",
      previewUrl: await this.previewUrl(),
      database: await this.database(isolated),
    });
    const deployment = await this.startDeployment();
    try {
      await work();
    } catch (err) {
      const message = (err as Error).message;
      const previewUrl = await this.previewUrl();
      await this.comment({
        phase: "failed",
        previewUrl,
        database: await this.database(isolated),
        error: message,
      });
      await this.deploymentStatus(deployment, {
        state: "failure",
        environmentUrl: previewUrl,
        description: message,
      });
      throw err;
    }
    const previewUrl = await this.previewUrl();
    await this.comment({ phase: "passed", previewUrl, database: await this.database(isolated) });
    await this.deploymentStatus(deployment, {
      state: "success",
      environmentUrl: previewUrl,
      description: "The Preview serves the expected database",
    });
    await this.deactivateDeployments(deployment);
  }

  /** Reports on `work` (down) when the PR closes. */
  async close(work: () => Promise<void>): Promise<void> {
    if (!this.commentOn && !this.deploymentsOn) return work();
    const own = await branchFor(this.branch, this.deps).catch(() => undefined);
    const database: Database | undefined =
      own && !own.persistent ? { kind: "own", name: own.name, ref: own.project_ref } : undefined;
    try {
      await work();
    } catch (err) {
      await this.comment({ phase: "cleanup-failed", database, error: (err as Error).message });
      throw err;
    }
    await this.comment({ phase: "removed", database });
    await this.deactivateDeployments();
  }

  private async database(isolated: boolean): Promise<Database> {
    const { config } = this.deps;
    if (isolated) {
      const own = await branchFor(this.branch, this.deps).catch(() => undefined);
      return { kind: "own", name: own?.name ?? this.branch, ref: own?.project_ref };
    }
    const shared = await this.deps.supabase
      .listBranches(config.supabaseProjectRef)
      .then((all) => all.find((b) => b.name === config.sharedBranch))
      .catch(() => undefined);
    return { kind: "shared", name: config.sharedBranch, ref: shared?.project_ref };
  }

  private async previewUrl(): Promise<string | undefined> {
    const preview = await this.deps.cloudflare
      .findPreview(previewKey(this.branch, this.deps.config, this.event.number))
      .catch(() => undefined);
    return preview?.urls[0]?.replace(/\/+$/, "");
  }

  private async comment(state: Pick<CommentState, "phase" | "previewUrl" | "database" | "error">) {
    if (!this.commentOn) return;
    const body = renderComment({
      ...state,
      worker: this.deps.config.worker,
      sha: this.sha,
      commitUrl: `${this.server}/${this.event.repository.full_name}/pull/${this.event.number}/commits/${this.sha}`,
      dashboardUrl: `https://supabase.com/dashboard/project/${this.deps.config.supabaseProjectRef}/branches`,
      updated: (this.deps.clock ?? (() => new Date()))(),
      runUrl: this.runUrl,
    });
    const ok = await this.safe("PR comment", async () => {
      this.commentId ??= await this.github.findComment(this.event.number, COMMENT_MARKER);
      if (this.commentId) await this.github.updateComment(this.commentId, body);
      else this.commentId = await this.github.createComment(this.event.number, body);
    });
    if (!ok) this.commentOn = false;
  }

  private async startDeployment(): Promise<number | undefined> {
    if (!this.deploymentsOn) return undefined;
    let id: number | undefined;
    const ok = await this.safe("GitHub deployment", async () => {
      id = await this.github.createDeployment({
        sha: this.sha,
        environment: this.environment,
        description: `Worker Preview of ${this.branch}`,
        payload: { [PAYLOAD_KEY]: this.event.number },
      });
      await this.github.setDeploymentStatus(id, { state: "in_progress", logUrl: this.runUrl });
    });
    if (!ok) this.deploymentsOn = false;
    return id;
  }

  private async deploymentStatus(
    id: number | undefined,
    args: { state: "success" | "failure"; environmentUrl?: string; description: string },
  ): Promise<void> {
    if (id === undefined || !this.deploymentsOn) return;
    await this.safe("GitHub deployment status", () =>
      this.github.setDeploymentStatus(id, { ...args, logUrl: this.runUrl }),
    );
  }

  /**
   * Transient deployments are never marked inactive automatically, so this PR's
   * older ones are retired here. Other PRs share the environment.
   */
  private async deactivateDeployments(keep?: number): Promise<void> {
    if (!this.deploymentsOn) return;
    await this.safe("GitHub deployment cleanup", async () => {
      for (const { id, payload } of await this.github.listDeployments(this.environment)) {
        if (id === keep || pullRequestOf(payload) !== this.event.number) continue;
        if (await this.github.isInactive(id)) continue;
        await this.github.setDeploymentStatus(id, { state: "inactive" });
      }
    });
  }

  private async safe(what: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      this.deps.runner.log(warning(`${what} skipped: ${(err as Error).message}`));
      return false;
    }
  }
}

/** GitHub may hand back a deployment payload as a JSON string. */
function pullRequestOf(payload: Deployment["payload"]): number | undefined {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const pr = (value as Record<string, unknown> | null | undefined)?.[PAYLOAD_KEY];
  return typeof pr === "number" ? pr : undefined;
}
