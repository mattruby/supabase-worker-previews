const API = "https://api.supabase.com/v1";

export type Branch = {
  id: string;
  name: string;
  project_ref: string;
  parent_project_ref?: string;
  is_default?: boolean;
  git_branch?: string | null;
  persistent?: boolean;
  status: string;
};
export type BranchDetail = { ref: string; status: string };
export type ProjectKeys = { publishable: string; secret: string };
type ApiKey = { name: string; type?: string | null; api_key: string };

export class SupabaseApi {
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Supabase API ${method} ${path}: ${res.status} ${await res.text()}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  getProject(ref: string): Promise<{ id: string; name: string; status: string }> {
    return this.call("GET", `/projects/${ref}`);
  }

  async listBranches(ref: string): Promise<Branch[]> {
    return (await this.call<Branch[]>("GET", `/projects/${ref}/branches`)) ?? [];
  }

  createBranch(
    ref: string,
    args: { name: string; gitBranch?: string; persistent?: boolean },
  ): Promise<Branch> {
    return this.call("POST", `/projects/${ref}/branches`, {
      branch_name: args.name,
      ...(args.gitBranch ? { git_branch: args.gitBranch } : {}),
      persistent: args.persistent ?? false,
    });
  }

  /** 404s for a few seconds after the branch is created. */
  getBranch(branchRef: string): Promise<BranchDetail> {
    return this.call("GET", `/branches/${branchRef}`);
  }

  updateBranch(branchRef: string, args: { gitBranch?: string; persistent?: boolean }): Promise<Branch> {
    return this.call("PATCH", `/branches/${branchRef}`, {
      ...(args.gitBranch ? { git_branch: args.gitBranch } : {}),
      ...(args.persistent !== undefined ? { persistent: args.persistent } : {}),
    });
  }

  deleteBranch(branchRef: string): Promise<unknown> {
    return this.call("DELETE", `/branches/${branchRef}`);
  }

  query<T>(ref: string, sql: string): Promise<T[]> {
    return this.call("POST", `/projects/${ref}/database/query`, { query: sql });
  }

  /** Legacy anon/service_role keys when the project has them, else the new publishable/secret pair. */
  async keys(ref: string): Promise<ProjectKeys> {
    const keys = await this.call<ApiKey[]>("GET", `/projects/${ref}/api-keys?reveal=true`);
    const byName = (n: string) => keys.find((k) => k.name === n)?.api_key;
    const byType = (t: string) => keys.find((k) => k.type === t)?.api_key;
    const publishable = byName("anon") ?? byType("publishable");
    const secret = byName("service_role") ?? byType("secret");
    if (!publishable || !secret) throw new Error(`Project ${ref} has no publishable or secret API key`);
    return { publishable, secret };
  }

  getAuthConfig(ref: string): Promise<{ site_url?: string; uri_allow_list?: string }> {
    return this.call("GET", `/projects/${ref}/config/auth`);
  }

  /** Sets the site URL and adds redirect URLs, keeping the ones already allowed. */
  async allowRedirects(ref: string, siteUrl: string, redirects: string[]): Promise<void> {
    const current = (await this.getAuthConfig(ref)).uri_allow_list ?? "";
    const list = [
      ...new Set([
        ...current
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        ...redirects,
      ]),
    ];
    await this.call("PATCH", `/projects/${ref}/config/auth`, {
      site_url: siteUrl,
      uri_allow_list: list.join(","),
    });
  }
}

export function projectUrl(ref: string): string {
  return `https://${ref}.supabase.co`;
}
