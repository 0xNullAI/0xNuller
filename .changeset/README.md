# Changesets

This directory holds release notes for `@dg-kit/*` packages.

## How to add a changeset

```bash
npx changeset
```

Pick the packages affected by your change, choose `patch`/`minor`/`major`, and write a one-line summary. The CLI writes a markdown file here. Commit it alongside your code change.

## Releasing

`Kit Version` runs on `dev`. With pending release notes it opens or updates the
`changeset-release/dev` Version PR. Merging that PR consumes the notes, bumps versions, and updates
`CHANGELOG.md`, but does not publish. The versioned packages are promoted through the next
`dev → main` product release PR. After the exact main commit passes CI, `Kit Release` publishes any
unpublished package versions to npm. It never creates a 0xNuller product GitHub Release.

All seven DG-Kit packages are pinned to the same version via the `fixed` list in `config.json` —
bumping one bumps the group. `dg-mcp` keeps an independent version and changes only when a changeset
explicitly selects it. A product `dev → main` PR is rejected while release notes are still pending;
merge the Kit Version PR first.

Private workspaces are not versioned by Changesets. Product versions are managed only by the
unified product release flow; a DG-Kit changeset must never rewrite app or Android versions.
