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

export class SupabaseApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Supabase API ${method} ${path}: ${status} ${body}`);
  }
}

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
    if (!res.ok) throw new SupabaseApiError(method, path, res.status, await res.text());
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  getProject(ref: string): Promise<{ id: string; name: string; status: string }> {
    return this.call("GET", `/projects/${ref}`);
  }

  async listBranches(ref: string): Promise<Branch[]> {
    return (await this.call<Branch[]>("GET", `/projects/${ref}/branches`)) ?? [];
  }

  async createBranch(
    ref: string,
    args: { name: string; gitBranch?: string; persistent?: boolean },
  ): Promise<Branch> {
    try {
      return await this.call<Branch>("POST", `/projects/${ref}/branches`, {
        branch_name: args.name,
        ...(args.gitBranch ? { git_branch: args.gitBranch } : {}),
        persistent: args.persistent ?? false,
      });
    } catch (err) {
      throw err instanceof SupabaseApiError ? new Error(explainCreateBranchError(ref, args.name, err)) : err;
    }
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

/** The plan-gate envelope: `{"error":{"code":"entitlement_required","feature":"branching_limit","upgrade_url":...}}`. */
function planGate(body: string): { feature?: string; upgrade_url?: string } | null {
  try {
    const error = (JSON.parse(body) as { error?: { code?: string; feature?: string; upgrade_url?: string } })
      .error;
    return error?.code === "entitlement_required" ? error : null;
  } catch {
    return null;
  }
}

export function explainCreateBranchError(ref: string, name: string, err: SupabaseApiError): string {
  const gate = planGate(err.body);
  const upgrade = gate?.upgrade_url ? ` (${gate.upgrade_url})` : "";
  let advice: string | undefined;
  if (gate?.feature === "branching_persistent")
    advice = `The organization's plan does not allow persistent branches${upgrade}.`;
  else if (
    gate?.feature === "branching_limit" ||
    /branch(es|ing)?[ _]limit|(maximum|max|too many)[\w ]* branches/i.test(err.body)
  )
    advice = `Project ${ref} has reached its branch limit. Delete branches you no longer need (\`swp prune\` lists leftovers) or raise the limit${upgrade}.`;
  else if (gate)
    advice = `The organization's plan does not include ${gate.feature ?? "this feature"}${upgrade}.`;
  else if (err.status === 401) advice = "The Supabase access token is invalid or expired.";
  else if (err.status === 403)
    advice = `The Supabase access token cannot create branches on ${ref}; use an organization-scoped token with access to it.`;
  else if (err.status === 409 || /already exists/i.test(err.body))
    advice = `A Supabase branch named "${name}" already exists on ${ref}.`;
  else if (err.status === 429)
    advice = "The Supabase API is rate limiting this token; run again in a minute.";
  return advice
    ? `Cannot create Supabase branch "${name}": ${advice} Supabase said: ${err.status} ${err.body}`
    : err.message;
}

export function projectUrl(ref: string): string {
  return `https://${ref}.supabase.co`;
}
