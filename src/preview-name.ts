/** A git branch as a DNS label, to match a Preview that was named by slug rather than by raw branch. */
export function previewName(branch: string): string {
  const name = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  if (!name) throw new Error(`Cannot make a Preview name from branch "${branch}"`);
  return name;
}

export function previewWildcard(worker: string, subdomain: string): string {
  return `https://*-${worker}.${subdomain}.workers.dev/**`;
}
