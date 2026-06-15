# Postman Node Runtime Policy Action

Enforces Node.js 22+ declarations across GitHub repositories and fails on
dependency engine ranges that are incompatible with Node 22 or newer. The action
is designed to be called from an organization ruleset required workflow so the
policy cannot be removed by individual repositories.

## Required Workflow

Use `.github/workflows/enforce-node22.yml` from this repository as the source
workflow for a `postman-cs` repository ruleset:

1. In organization rulesets, target the default branches for the selected repos.
2. Add **Require workflows to pass before merging**.
3. Select `postman-node-policy-action/.github/workflows/enforce-node22.yml`.
4. Start in evaluate mode, then switch to active after the first audit pass.
5. Pair the ruleset with pull-request requirements or direct-push restrictions.

The workflow checks out the pull request and runs:

```yaml
- uses: postman-cs/postman-node-policy-action@v1
  with:
    minimum-node-version: '22'
    preferred-node-version: '24'
    dependency-policy: compatible
    scan-dependencies: 'true'
```

## What It Checks

- `package.json` `engines.node` and `volta.node`
- `.nvmrc`, `.node-version`, and `.tool-versions`
- `actions/setup-node` `node-version` declarations in GitHub workflows
- `actions/setup-node` `node-version-file` references in GitHub workflows
- JavaScript action metadata, such as `runs.using: node20`
- Docker `FROM node:<version>` base images
- npm `package-lock.json`, pnpm lockfile, and installed `node_modules`
  dependency `engines.node` metadata

The default dependency policy is `compatible`: a dependency fails when its engine
range cannot run on Node 22 or newer. Set `dependency-policy: floor` for the
stricter mode that also fails dependencies whose declared engine floor permits
Node versions lower than 22.

Yarn lockfiles do not include dependency engine metadata. For Yarn repositories,
run a frozen Yarn install before this action so installed package manifests are
available to scan; otherwise the action fails instead of silently skipping
transitive dependency enforcement.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `minimum-node-version` | `22` | Minimum allowed Node.js version or major. |
| `preferred-node-version` | `24` | Preferred Node.js major used by safe fixes. |
| `dependency-policy` | `compatible` | `compatible` or `floor`. |
| `scan-dependencies` | `true` | Scan lockfile dependency engine metadata. |
| `allow-floating` | `false` | Allow `node`, `latest`, `current`, or `lts/*`. |
| `allow-missing` | `false` | Allow `package.json` without `engines.node`. |
| `fix-mode` | `none` | `none` or `write`. |
| `ignore-paths` | empty | Comma- or newline-separated additional ignores. |

## Safe Fixes

`fix-mode: write` updates first-party declarations only:

- `package.json` `engines.node`
- `.nvmrc` and `.node-version`
- `actions/setup-node` `node-version`
- `action.yml` `runs.using`

It never changes dependency versions. Use Dependabot, package-manager overrides,
or a dedicated remediation PR to resolve dependency engine conflicts.

## Local Reproduction

Run the same scanner locally from this repository against a checked-out target
repository:

```sh
node dist/cli.cjs --root . \
  --minimum-node-version 22 \
  --preferred-node-version 24 \
  --dependency-policy compatible
```

Use `--fix-mode write` only in a remediation branch where another step commits
the changed files. Do not use write mode in the org required workflow unless a
separate pull-request step persists the safe fixes.

## Release Runbook

Initial release:

```sh
git commit -m "feat: add Node runtime policy action"
git tag v1.0.0
git tag v1 v1.0.0
git push origin main
git push origin v1.0.0
git push origin v1
```

After the tags exist, `postman-cs/postman-node-policy-action@v1` is resolvable
for the organization ruleset required workflow. Future releases keep immutable
`v1.x.y` tags and move only the rolling `v1` alias.
