export type DeploymentState = "in_progress" | "success" | "failure" | "error" | "inactive";
type Comment = { id: number; body?: string };
export type Deployment = { id: number; payload?: unknown };

export class GitHubApi {
  constructor(
    private token: string,
    private repo: string,
    private fetchImpl: typeof fetch = fetch,
    private base = process.env.GITHUB_API_URL ?? "https://api.github.com",
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/repos/${this.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub API ${method} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  private async all<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; ; page += 1) {
      const batch = await this.call<T[]>("GET", `${path}${sep}per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }

  /** The id of the first comment on the issue or PR whose body starts with `marker`. */
  async findComment(issue: number, marker: string): Promise<number | undefined> {
    const comments = await this.all<Comment>(`/issues/${issue}/comments`);
    return comments.find((c) => c.body?.startsWith(marker))?.id;
  }

  async createComment(issue: number, body: string): Promise<number> {
    return (await this.call<Comment>("POST", `/issues/${issue}/comments`, { body })).id;
  }

  async updateComment(id: number, body: string): Promise<void> {
    await this.call("PATCH", `/issues/comments/${id}`, { body });
  }

  /** Skips the default merge and commit status checks, which would refuse a deployment while CI runs. */
  async createDeployment(args: {
    sha: string;
    environment: string;
    description: string;
    payload: Record<string, unknown>;
  }): Promise<number> {
    const deployment = await this.call<Deployment>("POST", "/deployments", {
      ref: args.sha,
      environment: args.environment,
      payload: args.payload,
      description: args.description,
      auto_merge: false,
      required_contexts: [],
      transient_environment: true,
      production_environment: false,
    });
    return deployment.id;
  }

  async setDeploymentStatus(
    id: number,
    args: { state: DeploymentState; environmentUrl?: string; logUrl?: string; description?: string },
  ): Promise<void> {
    await this.call("POST", `/deployments/${id}/statuses`, {
      state: args.state,
      ...(args.environmentUrl ? { environment_url: args.environmentUrl } : {}),
      ...(args.logUrl ? { log_url: args.logUrl } : {}),
      ...(args.description ? { description: args.description.slice(0, 140) } : {}),
    });
  }

  async isInactive(id: number): Promise<boolean> {
    const statuses = await this.all<{ state: string }>(`/deployments/${id}/statuses`);
    return statuses.some((s) => s.state === "inactive");
  }

  listDeployments(environment: string): Promise<Deployment[]> {
    return this.all<Deployment>(`/deployments?environment=${encodeURIComponent(environment)}`);
  }
}
