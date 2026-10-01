#!/usr/bin/env node
// Packs the package, installs the tarball into a throwaway project, and uses it the way a
// consumer would: the swp bin, `swp init` on a fixture Worker, the ESM runtime entry, and its types.
// Set KEEP_PACKAGE_CHECK=1 to keep the temp directory for inspection.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "swp-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let failures = 0;

function check(ok, message) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures++;
}

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
}

try {
  console.log(
    `node ${process.version}, npm ${execFileSync(npm, ["--version"], { encoding: "utf8" }).trim()}`,
  );

  // npm 10 prints the prepare script's output into the --json stdout, so read from the JSON array on.
  const packOutput = execFileSync(npm, ["pack", "--json", "--pack-destination", tmp], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [packed] = JSON.parse(packOutput.slice(packOutput.search(/^\[/m)));
  const shipped = packed.files.map((f) => f.path);
  console.log(`packed ${packed.filename}: ${shipped.length} files, ${packed.size} bytes`);
  for (const path of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/cli.js",
    "dist/runtime.js",
    "dist/runtime.d.ts",
    "templates/default-privileges.sql",
    "templates/supabase-previews.yml",
  ]) {
    check(shipped.includes(path), `tarball contains ${path}`);
  }
  const strays = shipped.filter((p) => /^(src|test|scripts|\.github|\.changeset)\//.test(p));
  check(
    strays.length === 0,
    `tarball has no source, test or repo files${strays.length ? `: ${strays}` : ""}`,
  );

  const consumer = join(tmp, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2),
  );
  const install = run(
    npm,
    ["install", "--no-audit", "--no-fund", "--loglevel=error", join(tmp, packed.filename)],
    consumer,
  );
  check(install.status === 0, `npm install of the tarball${install.status ? `\n${install.stderr}` : ""}`);

  const swp = join(consumer, "node_modules", ".bin", process.platform === "win32" ? "swp.cmd" : "swp");
  const help = run(swp, ["--help"], consumer);
  check(help.stdout.includes("swp init"), "swp --help prints the usage");
  const helpCommand = run(swp, ["help"], consumer);
  check(helpCommand.status === 0 && helpCommand.stdout.includes("swp init"), "swp help exits 0");

  const app = join(tmp, "app");
  mkdirSync(app);
  writeFileSync(
    join(app, "wrangler.jsonc"),
    `{\n  // fixture Worker\n  "name": "fixture-app",\n  "main": "src/index.ts",\n  "compatibility_date": "2026-09-01",\n}\n`,
  );
  const init = run(swp, ["init", "--project-ref", "abcdefghijklmnopqrst", "--trunk", "main"], app);
  check(init.status === 0, `swp init on a fixture wrangler.jsonc${init.status ? `\n${init.stderr}` : ""}`);
  const config = existsSync(join(app, "swp.config.json"))
    ? JSON.parse(readFileSync(join(app, "swp.config.json"), "utf8"))
    : {};
  check(config.supabaseProjectRef === "abcdefghijklmnopqrst", "swp init wrote swp.config.json");
  const migrations = existsSync(join(app, "supabase", "migrations"))
    ? readdirSync(join(app, "supabase", "migrations"))
    : [];
  check(
    migrations.some((f) => f.endsWith("_api_default_privileges.sql")),
    "swp init wrote the grants migration from the shipped template",
  );
  check(
    existsSync(join(app, ".github", "workflows", "supabase-previews.yml")),
    "swp init wrote the workflow from the shipped template",
  );

  writeFileSync(
    join(consumer, "import.mjs"),
    `import { withSupabasePreviews, IDENTITY_PATH } from "supabase-worker-previews";
const worker = withSupabasePreviews({ fetch: () => new Response("<html><head></head></html>", { headers: { "content-type": "text/html" } }) });
const env = { SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_PUBLISHABLE_KEY: "pk" };
const identity = await (await worker.fetch(new Request("https://x" + IDENTITY_PATH), env, {})).json();
const page = await (await worker.fetch(new Request("https://x/"), env, {})).text();
if (identity.projectRef !== "abcdefghijklmnopqrst" || !page.includes("__SUPABASE_PUBLIC__")) process.exit(1);
`,
  );
  const esm = run(process.execPath, ["import.mjs"], consumer);
  check(esm.status === 0, `ESM import of the runtime entry works${esm.status ? `\n${esm.stderr}` : ""}`);

  writeFileSync(
    join(consumer, "types.ts"),
    `import { withSupabasePreviews, type PublicConfig } from "supabase-worker-previews";
export const config: PublicConfig = { supabaseUrl: "u", supabaseKey: "k" };
export default withSupabasePreviews({ fetch: () => new Response("") });
`,
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, module: "nodenext", lib: ["es2023", "dom"], types: [] },
      files: ["types.ts"],
    }),
  );
  const tsc = run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc")], consumer);
  check(tsc.status === 0, `types resolve through "exports"${tsc.status ? `\n${tsc.stdout}` : ""}`);
} finally {
  if (process.env.KEEP_PACKAGE_CHECK) console.log(`kept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} package check(s) failed`);
  process.exit(1);
}
console.log("\npackage check passed");
