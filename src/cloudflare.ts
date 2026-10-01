import { previewName } from "./preview-name.js";
import type { Runner } from "./run.js";

export type CloudflareAuth = { apiToken: string; accountId: string };

export type PreviewRecord = {
  id: string;
  name: string;
  slug: string;
  urls: string[];
  deployed_on: string | null;
};

/** Workers Builds names a Preview after the raw git branch; Cloudflare derives the slug and hostname. */
export function matchPreview(previews: PreviewRecord[], gitBranch: string): PreviewRecord | undefined {
  return (
    previews.find((p) => p.name === gitBranch) ?? previews.find((p) => p.slug === previewName(gitBranch))
  );
}

/** Preview operations go through wrangler; only the subdomain lookup is a direct API call. */
export class CloudflareApi {
  private subdomain?: string;

  constructor(
    private runner: Runner,
    private auth: CloudflareAuth,
    private worker: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private get env() {
    return { CLOUDFLARE_API_TOKEN: this.auth.apiToken, CLOUDFLARE_ACCOUNT_ID: this.auth.accountId };
  }

  private wrangler(args: string[], opts: { input?: string; captureStderr?: boolean } = {}): string {
    return this.runner.exec("npx", ["wrangler", ...args, "--worker-name", this.worker], {
      env: this.env,
      ...opts,
    });
  }

  private async api<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${this.auth.accountId}${path}`,
      {
        headers: { authorization: `Bearer ${this.auth.apiToken}` },
      },
    );
    const json = (await res.json()) as { result?: T; errors?: { message: string }[] };
    if (!res.ok || json.result === undefined)
      throw new Error(
        `Cloudflare API ${path}: ${res.status} ${json.errors?.map((e) => e.message).join("; ") ?? ""}`,
      );
    return json.result;
  }

  async workersSubdomain(): Promise<string> {
    this.subdomain ??= (await this.api<{ subdomain: string }>("/workers/subdomain")).subdomain;
    return this.subdomain;
  }

  async listPreviews(): Promise<PreviewRecord[]> {
    const all: PreviewRecord[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.api<PreviewRecord[]>(
        `/workers/workers/${this.worker}/previews?per_page=100&page=${page}`,
      );
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }

  async findPreview(gitBranch: string): Promise<PreviewRecord | undefined> {
    return matchPreview(await this.listPreviews(), gitBranch);
  }

  /** Writing to a Preview creates a new deployment of it. */
  putPreviewSecrets(preview: string, secrets: Record<string, string>): void {
    if (this.runner.dryRun) {
      this.runner.log(
        `  $ npx wrangler preview secret bulk --name ${preview}  (${Object.keys(secrets).join(", ")})`,
      );
      return;
    }
    this.wrangler(["preview", "secret", "bulk", "--name", preview], { input: JSON.stringify(secrets) });
  }

  listPreviewSecrets(preview: string): string[] {
    const out = this.wrangler(["preview", "secret", "list", "--name", preview, "--json"], {
      captureStderr: true,
    });
    const start = out.search(/^\[/m);
    return start === -1 ? [] : (JSON.parse(out.slice(start)) as { name: string }[]).map((s) => s.name);
  }

  /** Creates a new deployment of the Preview, like any secret write. */
  deletePreviewSecret(preview: string, key: string): void {
    this.wrangler(["preview", "secret", "delete", key, "--name", preview, "--skip-confirmation"], {
      captureStderr: true,
    });
  }

  /** Merges: keys absent from `secrets` stay. Only Previews created afterwards copy it. */
  putBaseSecrets(secrets: Record<string, string>): void {
    if (this.runner.dryRun) {
      this.runner.log(
        `  $ npx wrangler preview base-config secret bulk  (${Object.keys(secrets).join(", ")})`,
      );
      return;
    }
    this.wrangler(["preview", "base-config", "secret", "bulk"], { input: JSON.stringify(secrets) });
  }

  deletePreview(preview: string): void {
    this.wrangler(["preview", "delete", "--name", preview, "--skip-confirmation"], { captureStderr: true });
  }
}
