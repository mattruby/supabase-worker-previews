import type { CloudflareApi, PreviewRecord } from "../cloudflare.js";
import type { Config } from "../config.js";
import { previewWildcard } from "../preview-name.js";
import type { Runner } from "../run.js";
import { projectUrl, type Branch, type SupabaseApi } from "../supabase.js";
import { IDENTITY_PATH, OVERRIDE_SECRET, type SupabaseValues } from "../runtime.js";

export type Deps = {
  config: Config;
  runner: Runner;
  supabase: SupabaseApi;
  cloudflare: CloudflareApi;
  migrationCount: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchImpl: typeof fetch;
  now?: () => number;
};

const MIGRATION_COUNT_SQL = "select count(*)::int as n from supabase_migrations.schema_migrations";
const BRANCH_FAILED = ["MIGRATIONS_FAILED", "FUNCTIONS_FAILED"];

async function subdomainOf(deps: Deps): Promise<string> {
  return deps.config.workersSubdomain ?? deps.cloudflare.workersSubdomain();
}

/** The non-default Supabase branch tied to a git branch, made by the GitHub integration or by `up`. */
export async function branchFor(gitBranch: string, deps: Deps): Promise<Branch | undefined> {
  const branches = await deps.supabase.listBranches(deps.config.supabaseProjectRef);
  return branches.find((b) => b.git_branch === gitBranch && !b.is_default);
}

/** Never repoint, write to or delete the production project through a branch record. */
export function assertIsolated(branch: Branch, parent: string): void {
  if (branch.is_default || branch.project_ref === parent) {
    throw new Error(
      `Supabase branch "${branch.name}" is the production project ${parent} itself; refusing to touch it`,
    );
  }
}

export async function supabaseValues(ref: string, deps: Deps): Promise<SupabaseValues> {
  const keys = await deps.supabase.keys(ref, deps.config.apiKeys);
  return {
    SUPABASE_URL: projectUrl(ref),
    SUPABASE_PUBLISHABLE_KEY: keys.publishable,
    SUPABASE_SERVICE_ROLE_KEY: keys.secret,
    SUPABASE_PROJECT_REF: ref,
  };
}

/**
 * The shared Preview database: a persistent branch that tracks the trunk, so
 * the GitHub integration migrates it on every trunk push. Its public values
 * belong in wrangler `previews.vars`; only its secret key goes in the Preview
 * base config.
 */
export async function shared(deps: Deps): Promise<string> {
  const { config, runner, supabase } = deps;
  const parent = config.supabaseProjectRef;
  runner.log(`Shared Preview database "${config.sharedBranch}" on ${parent}, tracking ${config.trunk}`);
  const branches = await supabase.listBranches(parent);
  if (runner.dryRun) {
    runner.log(
      `  ${branches.some((b) => b.name === config.sharedBranch) ? "update" : "create"} the persistent branch`,
    );
    return `<${config.sharedBranch}>`;
  }
  if (!branches.some((b) => b.is_default)) await enableBranching(deps);
  let branch = branches.find((b) => b.name === config.sharedBranch);
  if (!branch) {
    branch = await supabase.createBranch(parent, {
      name: config.sharedBranch,
      gitBranch: config.trunk,
      persistent: true,
    });
  } else if (branch.git_branch !== config.trunk || !branch.persistent) {
    await supabase.updateBranch(branch.project_ref, { gitBranch: config.trunk, persistent: true });
  }
  assertIsolated(branch, parent);
  const ref = branch.project_ref;
  await waitForMigrations(ref, deps);
  const subdomain = await subdomainOf(deps);
  await supabase.allowRedirects(ref, `https://${config.worker}.${subdomain}.workers.dev`, [
    previewWildcard(config.worker, subdomain),
  ]);
  const values = await supabaseValues(ref, deps);
  deps.cloudflare.putBaseSecrets({ SUPABASE_SERVICE_ROLE_KEY: values.SUPABASE_SERVICE_ROLE_KEY });
  runner.log(`Done: ${ref}. Put these in the wrangler config under previews.vars:`);
  runner.log(
    JSON.stringify(
      {
        SUPABASE_URL: values.SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY: values.SUPABASE_PUBLISHABLE_KEY,
        SUPABASE_PROJECT_REF: ref,
      },
      null,
      2,
    ),
  );
  return ref;
}

/**
 * The first branch made on a never-branched project either relabels the
 * project itself or creates a real database and names the project "main".
 * A throwaway first branch keeps a real one from being mistaken for production.
 */
export async function enableBranching(deps: Deps): Promise<void> {
  const parent = deps.config.supabaseProjectRef;
  const first = await deps.supabase.createBranch(parent, { name: "production" });
  if (first.project_ref === parent) {
    deps.runner.log(`  branching enabled on ${parent}; its default branch is "production"`);
    return;
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      await deps.supabase.deleteBranch(first.project_ref);
      break;
    } catch (err) {
      if (attempt >= 12) throw err;
      await deps.sleep(5_000);
    }
  }
  deps.runner.log(`  branching enabled on ${parent}; removed the extra first branch ${first.project_ref}`);
}

/**
 * Gives a git branch's Preview its own database. The GitHub integration makes
 * one for any PR that changes supabase/; for other branches this asks for one,
 * which Supabase still migrates and seeds from that git branch.
 */
export async function up(gitBranch: string, deps: Deps): Promise<string> {
  const { config, runner, supabase } = deps;
  runner.log(`Isolated database for ${gitBranch}`);
  if (runner.dryRun) {
    runner.log(`  find or create the Supabase branch for ${gitBranch}, wait for its migrations`);
    runner.log(`  set ${OVERRIDE_SECRET} on the Preview of ${gitBranch}`);
    return `<${gitBranch}>`;
  }
  const branch =
    (await branchFor(gitBranch, deps)) ??
    (await supabase.createBranch(config.supabaseProjectRef, { name: gitBranch, gitBranch }));
  assertIsolated(branch, config.supabaseProjectRef);
  const ref = branch.project_ref;
  await waitForMigrations(ref, deps);
  const preview = await waitForPreview(gitBranch, deps);
  const url = previewUrlOf(preview);
  await supabase.allowRedirects(ref, url, [`${url}/**`]);
  deps.cloudflare.putPreviewSecrets(preview.name, {
    [OVERRIDE_SECRET]: JSON.stringify(await supabaseValues(ref, deps)),
  });
  runner.log(`Done: ${url} now runs on ${ref}`);
  return ref;
}

/** Which database a deployed Preview serves, from the identity route or, failing that, its HTML. */
export async function servedRef(baseUrl: string, deps: Deps): Promise<{ ref?: string; seen: string }> {
  const identity = await deps.fetchImpl(`${baseUrl}${IDENTITY_PATH}`).catch(() => null);
  if (identity?.ok && (identity.headers.get("content-type") ?? "").includes("json")) {
    const body = (await identity.json()) as { projectRef?: string | null };
    if (body.projectRef) return { ref: body.projectRef, seen: body.projectRef };
  }
  const page = await deps.fetchImpl(`${baseUrl}${deps.config.checkPath}`).catch(() => null);
  if (!page?.ok) return { seen: `HTTP ${page?.status ?? "error"}` };
  const refs = new Set(
    [...(await page.text()).matchAll(/https:\/\/([a-z0-9]{20})\.supabase\.co/g)].map((m) => m[1]!),
  );
  if (refs.size > 1) return { seen: `several databases in the page: ${[...refs].join(", ")}` };
  const [ref] = refs;
  return ref ? { ref, seen: ref } : { seen: "no Supabase URL in the page" };
}

/**
 * Fails unless the Preview serves the database it should: its own branch
 * when isolated, else the shared one. Production fails at once; anything
 * else is retried while Workers Builds and `up` finish.
 */
export async function check(gitBranch: string, isolated: boolean, deps: Deps): Promise<void> {
  const { config, runner, supabase } = deps;
  const parent = config.supabaseProjectRef;
  const want = isolated ? `the branch for ${gitBranch}` : config.sharedBranch;
  if (runner.dryRun) {
    runner.log(`  the Preview of ${gitBranch} must serve ${want}`);
    return;
  }
  const expected = isolated
    ? await branchFor(gitBranch, deps)
    : (await supabase.listBranches(parent)).find((b) => b.name === config.sharedBranch);
  if (!expected) throw new Error(`No Supabase branch for ${want} on ${parent}`);
  assertIsolated(expected, parent);
  let seen = "nothing yet";
  for (let attempt = 1; attempt <= 45; attempt += 1) {
    const preview = await deps.cloudflare.findPreview(gitBranch);
    if (!preview) seen = "no Preview yet";
    else if (!preview.deployed_on) seen = `Preview ${preview.slug} exists but was never deployed`;
    else {
      const result = await servedRef(previewUrlOf(preview), deps);
      if (result.ref === parent)
        throw new Error(`Preview ${preview.slug} serves the production database ${parent}; refusing to pass`);
      if (result.ref === expected.project_ref) {
        runner.log(`  Preview ${preview.slug} runs on ${expected.name} (${result.ref})`);
        return;
      }
      seen = result.seen;
    }
    await deps.sleep(20_000);
  }
  throw new Error(
    `The Preview of ${gitBranch} never served ${want} (${expected.project_ref}); last saw ${seen}`,
  );
}

/** Removes the Preview and, if the integration has not already, its own database. */
export async function down(gitBranch: string, deps: Deps): Promise<void> {
  const { config, runner } = deps;
  runner.log(`Removing the Preview of ${gitBranch} and any database of its own`);
  const branch = await branchFor(gitBranch, deps);
  if (!branch || branch.persistent) {
    runner.log(`  no Supabase branch of its own`);
  } else if (runner.dryRun) {
    runner.log(`  DELETE Supabase branch ${branch.name} (${branch.project_ref})`);
  } else {
    assertIsolated(branch, config.supabaseProjectRef);
    await deps.supabase.deleteBranch(branch.project_ref);
    runner.log(`  Supabase branch ${branch.name} deleted`);
  }
  const preview = await deps.cloudflare.findPreview(gitBranch);
  if (!preview) runner.log(`  no Preview to delete`);
  else if (runner.dryRun) runner.log(`  delete Preview ${preview.name}`);
  else deps.cloudflare.deletePreview(preview.name);
}

/** On a PR's first push, Workers Builds may still be creating the Preview. */
async function waitForPreview(gitBranch: string, deps: Deps): Promise<PreviewRecord> {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const preview = await deps.cloudflare.findPreview(gitBranch);
    if (preview) return preview;
    deps.runner.log(`  waiting for the Preview of ${gitBranch} to exist (${attempt})`);
    await deps.sleep(20_000);
  }
  throw new Error(`No Preview of ${gitBranch} appeared; is Workers Builds building this branch?`);
}

function previewUrlOf(preview: PreviewRecord): string {
  const url = preview.urls[0];
  if (!url) throw new Error(`Preview ${preview.slug} has no URL`);
  return url.replace(/\/+$/, "");
}

/**
 * Ready when the branch holds every migration in this checkout. Branch status
 * runs ahead of the migrations, so the status alone is not enough.
 */
export async function waitForMigrations(ref: string, deps: Deps): Promise<void> {
  const want = deps.migrationCount();
  const now = deps.now ?? Date.now;
  const started = now();
  let last = "not created yet";
  while (now() - started < 15 * 60_000) {
    const detail = await deps.supabase.getBranch(ref).catch((err: Error) => {
      if (/\b404\b/.test(err.message)) return null;
      throw err;
    });
    if (detail) {
      const branch = (await deps.supabase.listBranches(deps.config.supabaseProjectRef)).find(
        (b) => b.project_ref === ref,
      );
      const status = branch?.status ?? detail.status;
      if (BRANCH_FAILED.includes(status)) throw new Error(`Supabase branch ${ref} ended ${status}`);
      const rows = await deps.supabase.query<{ n: number }>(ref, MIGRATION_COUNT_SQL).catch(() => []);
      const have = rows[0]?.n ?? 0;
      if (have >= want) return;
      last = `${have} of ${want} migrations, ${status}`;
    }
    await deps.sleep(10_000);
  }
  throw new Error(`Supabase branch ${ref} not ready after 15 minutes: ${last}`);
}
