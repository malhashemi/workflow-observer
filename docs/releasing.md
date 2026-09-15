# Releasing

CI runs on GitHub-hosted runners. A push to `main`, including a merged PR, builds the app, runs TypeScript/OXC checks and tests, and exercises the packed CLI with isolated data. A separate release job publishes that tested archive through npm trusted publishing, then creates a matching GitHub tag and release. A version already on npm is skipped. No npm token is stored in GitHub.

## Release a change

On your PR branch:

```sh
bun run release:prepare patch  # or minor / major
git add package.json bun.lock
git commit -m 'chore: prepare release'
```

Merge the PR after **Check and package** passes. Check **Publish to npm** in [Actions](https://github.com/malhashemi/workflow-observer/actions/workflows/ci.yml). The PR description supplies context for GitHub's generated release notes.

Version preparation only changes package metadata and the lockfile. It does not commit, tag or publish. Rebase and choose a new version if another release lands first. Merges without a new version run checks without publishing. Keep prereleases out of `main`; this workflow publishes stable versions to `latest`.

## One-time setup

1. Enable GitHub Actions for this repository. Both jobs use `ubuntu-latest`.
2. In [the npm package settings](https://www.npmjs.com/package/workflow-observer/access), add a **GitHub Actions** trusted publisher with owner **malhashemi**, repository **workflow-observer**, and workflow filename **ci.yml**. Leave the environment name empty and allow direct publishing. The package must already exist; use the manual bootstrap below for a new package.
3. Require **Check and package** before merging into `main` in the repository's branch rules.

[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) currently supports GitHub-hosted runners, not self-hosted runners. The publishing job uses `id-token: write` and Node 24. npm exchanges the workflow's short-lived OIDC identity for permission to publish and attaches provenance. Observer itself runs on Bun.

For the first publication, from a checked-out release commit:

```sh
npm login
bun install --frozen-lockfile
bun run build
bun run check
bun test
bun run test:package
npm publish ./workflow-observer-0.9.4.tgz --access public --ignore-scripts
```

Use the archive for the version in `package.json`. After bootstrap, configure its trusted publisher once. Later releases require no npm login or token rotation.

## Retry a release

Fix the reported failure, then rerun the workflow from Actions. For authentication failures, check the exact owner, repository and workflow filename against npm's saved publisher. Transient registry errors fail explicitly instead of being treated as an unpublished version.

If npm succeeded but GitHub release creation failed, the published version is immutable. Create the missing release against the original successful run's commit, and attach its `npm-package` artifact:

```sh
gh release create vVERSION ./workflow-observer-VERSION.tgz \
  --repo malhashemi/workflow-observer --target COMMIT_SHA \
  --title vVERSION --generate-notes
```

If a published package needs a code fix, prepare a new patch version in a PR. Do not replace a published version or move its tag.
