# Changesets

This directory holds release notes for `@dg-kit/*` packages.

## How to add a changeset

```bash
npx changeset
```

Pick the packages affected by your change, choose `patch`/`minor`/`major`, and write a one-line summary. The CLI writes a markdown file here. Commit it alongside your code change.

## Releasing

The release workflow runs `changeset version` to bump versions and update `CHANGELOG.md`, then `changeset publish` to push the new versions to npm. All seven packages are pinned to the same version via the `fixed` list in `config.json` — bumping any one of them bumps them all. `dg-mcp` is explicitly ignored because it has a separate product version and must never hitch a ride on a Kit release. It is released only through the manually approved `Release dg-mcp` workflow, which requires an exact manifest version and refuses an existing registry version.
