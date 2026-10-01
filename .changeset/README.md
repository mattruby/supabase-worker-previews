# Changesets

Every pull request that changes what users get (the CLI, the runtime entry, the templates) adds a changeset:

```sh
npx changeset
```

Pick the bump (patch for fixes, minor for features while the package is 0.x) and write one or two sentences for the changelog, from the user's point of view. Changes to tests, CI or docs alone need no changeset.

See [RELEASING.md](../RELEASING.md) for how changesets turn into releases.
