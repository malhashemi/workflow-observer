# Releasing

CI runs on Blacksmith. A push to `main`, including a merged PR, builds the app, runs TypeScript/OXC checks and tests, and exercises the packed CLI with isolated data. The release job publishes that tested archive when its version is absent from npm, then creates a matching GitHub tag and release. A version already on npm is skipped. PR checks never receive the publishing token.

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

1. Enable the Blacksmith GitHub App for this repository. Both jobs use `blacksmith-4vcpu-ubuntu-2404`.
2. Authenticate with npm and confirm ownership of `workflow-observer`. If this is the first publication, use the manual bootstrap below.
3. Create a granular npm token with read/write access to this package and **Bypass two-factor authentication** enabled for unattended publication. Store it as the repository Actions secret **NPM_TOKEN**. Set an expiration reminder and replace the secret when rotating the token.
4. Require **Check and package** before merging into `main` in the repository's branch rules.

[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) currently supports GitHub-hosted runners, not self-hosted runners. This workflow uses a token so publishing stays on Blacksmith. It does not request npm provenance or claim OIDC authentication. Node is used only by the CI npm publisher; Observer itself runs on Bun.

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

Use the archive for the version in `package.json`. After bootstrap, the CI token can be restricted to the newly created package.

## Retry a release

Fix a missing/expired `NPM_TOKEN` or Blacksmith access issue, then rerun the failed workflow from Actions. Transient registry errors fail explicitly instead of being treated as an unpublished version.

If npm succeeded but GitHub release creation failed, the published version is immutable. Create the missing release against the original successful run's commit, and attach its `npm-package` artifact:

```sh
gh release create vVERSION ./workflow-observer-VERSION.tgz \
  --repo malhashemi/workflow-observer --target COMMIT_SHA \
  --title vVERSION --generate-notes
```

If a published package needs a code fix, prepare a new patch version in a PR. Do not replace a published version or move its tag.
