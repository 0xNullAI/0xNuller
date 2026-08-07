# Changesets

This directory holds release notes for `@dg-kit/*` packages.

## How to add a changeset

```bash
npx changeset
```

Pick the packages affected by your change, choose `patch`/`minor`/`major`, and write a one-line summary. The CLI writes a markdown file here. Commit it alongside your code change.

## Releasing

The release workflow runs `changeset version` to bump versions and update `CHANGELOG.md`, then `changeset publish` to push the new versions to npm. All five packages are pinned to the same version via the `fixed` list in `config.json` — bumping any one of them bumps them all.
