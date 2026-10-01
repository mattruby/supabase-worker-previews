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
export type KeyKind = "legacy" | "new";
export type ApiKey = {
  name: string;
  type?: "legacy" | "publishable" | "secret" | null;
  api_key?: string | null;
};
export type ActionRun = {
  id: string;
  git_config?: { owner?: string; repo?: string; ref?: string } | null;
  created_at: string;
};

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

  /** The preferred kind of key pair when the project has it (and legacy keys are enabled), else the other. */
  async keys(ref: string, prefer: KeyKind = "legacy"): Promise<ProjectKeys> {
    const keys = await this.call<ApiKey[]>("GET", `/projects/${ref}/api-keys?reveal=true`);
    const pairs = { legacy: legacyPair(keys), new: newPair(keys) };
    if (pairs.legacy && !(await this.legacyKeysEnabled(ref))) pairs.legacy = null;
    const pair = pairs[prefer] ?? pairs[prefer === "legacy" ? "new" : "legacy"];
    if (!pair) {
      const masked = keys.some((k) => k.api_key && !revealed(k.api_key));
      throw new Error(
        masked
          ? `Project ${ref}: the access token cannot reveal secret API keys; use a token with the project's secrets permission`
          : `Project ${ref} has no publishable and secret API key pair`,
      );
    }
    return pair;
  }

  private async legacyKeysEnabled(ref: string): Promise<boolean> {
    const status = await this.call<{ enabled?: boolean }>("GET", `/projects/${ref}/api-keys/legacy`).catch(
      () => null,
    );
    return status?.enabled !== false;
  }

  /** Newest first. Runs the GitHub integration made carry `git_config`. */
  async actionRuns(branchRef: string): Promise<ActionRun[]> {
    return (await this.call<ActionRun[]>("GET", `/projects/${branchRef}/actions`)) ?? [];
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

/** Without `reveal`, or without permission to reveal, secret keys come back with `·` in place of characters. */
function revealed(key: string): boolean {
  return !key.includes("·");
}

function legacyPair(keys: ApiKey[]): ProjectKeys | null {
  const find = (name: string) =>
    keys.find((k) => k.name === name && (k.type ?? "legacy") === "legacy" && k.api_key && revealed(k.api_key))
      ?.api_key;
  const publishable = find("anon");
  const secret = find("service_role");
  return publishable && secret ? { publishable, secret } : null;
}

function newPair(keys: ApiKey[]): ProjectKeys | null {
  const find = (type: "publishable" | "secret") => {
    const usable = keys.filter((k) => k.type === type && k.api_key && revealed(k.api_key));
    return (usable.find((k) => k.name === "default") ?? usable[0])?.api_key;
  };
  const publishable = find("publishable");
  const secret = find("secret");
  return publishable && secret ? { publishable, secret } : null;
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
