# Changesets

This directory holds release notes for `@dg-kit/*` packages.

## How to add a changeset

```bash
npx changeset
```

Pick the packages affected by your change, choose `patch`/`minor`/`major`, and write a one-line summary. The CLI writes a markdown file here. Commit it alongside your code change.

## Releasing

The release workflow runs `changeset version` to bump versions and update `CHANGELOG.md`, then
`changeset publish` to publish packages. All seven DG-Kit packages are pinned to the same version via
the `fixed` list in `config.json` — bumping one bumps the group. `dg-mcp` keeps an independent version
and changes only when a changeset explicitly selects it.

Private workspaces are not versioned by Changesets. Product versions are managed only by the
unified product release flow; a DG-Kit changeset must never rewrite app or Android versions.
