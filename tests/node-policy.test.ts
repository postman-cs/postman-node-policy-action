import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, test } from 'vitest';

import { checkNodePolicy } from '../src/index.js';

const tempRoots: string[] = [];

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'node-policy-'));
  tempRoots.push(root);
  return root;
}

async function write(root: string, path: string, contents: string): Promise<void> {
  const fullPath = join(root, path);
  await import('node:fs/promises').then(async ({ mkdir }) => {
    await mkdir(join(fullPath, '..'), { recursive: true });
  });
  await writeFile(fullPath, contents);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('checkNodePolicy', () => {
  test('reports root package, setup-node, action runtime, and version-file declarations below Node 22', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=20' } }, null, 2)}\n`);
    await write(root, '.nvmrc', '20.19.0\n');
    await write(root, 'action.yml', 'runs:\n  using: node20\n  main: dist/index.cjs\n');
    await write(root, '.github/workflows/ci.yml', [
      'name: ci',
      'on: [pull_request]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version: 20',
      ''
    ].join('\n'));

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.status).toBe('failed');
    expect(result.violations.map((violation) => `${violation.file}:${violation.kind}`)).toEqual([
      '.github/workflows/ci.yml:setup-node',
      '.nvmrc:node-version-file',
      'action.yml:action-runtime',
      'package.json:package-engines'
    ]);
    expect(result.summary).toContain('Node Runtime Policy Failed');
    expect(result.summary).toContain('npm pkg set engines.node=">=22"');
  });

  test('floor dependency policy fails ranges that permit Node below 22', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'package-lock.json', `${JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', version: '1.0.0' },
        'node_modules/compatible-floor': {
          version: '1.0.0',
          engines: { node: '>=18' }
        },
        'node_modules/legacy-only': {
          version: '1.0.0',
          engines: { node: '<22' }
        }
      }
    }, null, 2)}\n`);

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'floor',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations.map((violation) => ({
      file: violation.file,
      kind: violation.kind,
      packageName: violation.packageName,
      current: violation.current
    }))).toEqual([
      {
        file: 'package-lock.json',
        kind: 'dependency-engine',
        packageName: 'compatible-floor',
        current: '>=18'
      },
      {
        file: 'package-lock.json',
        kind: 'dependency-engine',
        packageName: 'legacy-only',
        current: '<22'
      }
    ]);
  });

  test('strict dependency floor mode fails dependencies that permit lower Node versions', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'package-lock.json', `${JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', version: '1.0.0' },
        'node_modules/compatible-floor': {
          version: '1.0.0',
          engines: { node: '>=18' }
        }
      }
    }, null, 2)}\n`);

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'floor',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations.map((violation) => ({
      file: violation.file,
      kind: violation.kind,
      packageName: violation.packageName,
      current: violation.current
    }))).toEqual([
      {
        file: 'package-lock.json',
        kind: 'dependency-engine',
        packageName: 'compatible-floor',
        current: '>=18'
      }
    ]);
  });

  test('fails package-lock files that lack package engine metadata', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'package-lock.json', `${JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        legacy: { version: '1.0.0' }
      }
    }, null, 2)}\n`);

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations[0]).toMatchObject({
      file: 'package-lock.json',
      kind: 'unsupported-package-lock',
      current: 'package-lock.json'
    });
  });

  test('reports scoped dependency names from package-lock paths when metadata omits name', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'package-lock.json', `${JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', version: '1.0.0' },
        'node_modules/@scope/legacy': {
          version: '1.0.0',
          engines: { node: '<22' }
        }
      }
    }, null, 2)}\n`);

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations[0]).toMatchObject({
      kind: 'dependency-engine',
      packageName: '@scope/legacy'
    });
    expect(result.summary).toContain('Upgrade or replace @scope/legacy');
  });

  test('fails yarn lockfiles when dependency engine metadata is unavailable', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'yarn.lock', '# yarn lockfile v1\n');

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations[0]).toMatchObject({
      file: 'yarn.lock',
      kind: 'unsupported-lockfile',
      current: 'yarn.lock'
    });
    expect(result.summary).toContain('yarn install --immutable');
    expect(result.summary).not.toContain('npm pkg set engines.node');
  });

  test('accepts yarn lockfiles when another lockfile provides dependency metadata', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'package-lock.json', `${JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', version: '1.0.0' },
        'node_modules/current': {
          version: '1.0.0',
          engines: { node: '>=22' }
        }
      }
    }, null, 2)}\n`);
    await write(root, 'yarn.lock', '# yarn lockfile v1\n');

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.status).toBe('passed');
    expect(result.violations).toEqual([]);
  });

  test('fails nested yarn lockfiles when only another package has dependency metadata', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'package-lock.json', `${JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', version: '1.0.0' },
        'node_modules/current': {
          version: '1.0.0',
          engines: { node: '>=22' }
        }
      }
    }, null, 2)}\n`);
    await write(root, 'packages/yarn-app/package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'packages/yarn-app/yarn.lock', '# yarn lockfile v1\n');

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations[0]).toMatchObject({
      file: 'packages/yarn-app/yarn.lock',
      kind: 'unsupported-lockfile',
      current: 'packages/yarn-app/yarn.lock'
    });
    expect(result.summary).toContain('(cd packages/yarn-app && (yarn install --immutable || yarn install --frozen-lockfile))');
  });

  test('scans installed package manifests for yarn repos when node_modules is present', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'yarn.lock', '# yarn lockfile v1\n');
    await write(root, 'node_modules/@scope/legacy/package.json', `${JSON.stringify({
      name: '@scope/legacy',
      version: '1.0.0',
      engines: { node: '<22' }
    }, null, 2)}\n`);

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations.map((violation) => ({
      file: violation.file,
      kind: violation.kind,
      packageName: violation.packageName
    }))).toEqual([
      {
        file: 'node_modules/@scope/legacy/package.json',
        kind: 'dependency-engine',
        packageName: '@scope/legacy'
      }
    ]);
  });

  test('fails unreadable installed package manifests instead of passing silently', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'yarn.lock', '# yarn lockfile v1\n');
    await write(root, 'node_modules/broken/package.json', '{ "name": "broken", "engines": ');

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations[0]).toMatchObject({
      file: 'node_modules/broken/package.json',
      kind: 'invalid-installed-package-json',
      title: 'Invalid installed package manifest'
    });
  });

  test('ignores built-in generated directories at any workspace depth', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'packages/app/node_modules/legacy/package.json', `${JSON.stringify({
      name: 'legacy',
      version: '1.0.0'
    }, null, 2)}\n`);
    await write(root, 'packages/app/dist/package.json', `${JSON.stringify({
      name: 'generated',
      engines: { node: '<22' }
    }, null, 2)}\n`);

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.status).toBe('passed');
    expect(result.violations).toEqual([]);
  });

  test('fails unreadable package manifests instead of passing silently', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', '{ "name": "broken", "engines": ');

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.status).toBe('failed');
    expect(result.violations[0]).toMatchObject({
      file: 'package.json',
      kind: 'invalid-package-json',
      title: 'Invalid package.json'
    });
  });

  test('fails malformed structured policy files instead of passing silently', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'action.yml', 'runs: [\n');
    await write(root, '.github/workflows/ci.yml', 'jobs: [\n');
    await write(root, 'package-lock.json', '{ "lockfileVersion": 3, "packages": ');
    await write(root, 'pnpm-lock.yaml', 'packages: [\n');

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.status).toBe('failed');
    expect(result.violations.map((violation) => `${violation.file}:${violation.kind}`)).toEqual(expect.arrayContaining([
      '.github/workflows/ci.yml:invalid-workflow-yaml',
      'action.yml:invalid-action-yaml',
      'package-lock.json:invalid-package-lock',
      'pnpm-lock.yaml:invalid-pnpm-lock'
    ]));
  });

  test('fails empty Node version files instead of passing silently', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, '.nvmrc', '\n');
    await write(root, 'config/node-version.txt', '   \n');
    await write(root, '.github/workflows/ci.yml', [
      'name: ci',
      'on: [pull_request]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version-file: .nvmrc',
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version-file: config/node-version.txt',
      ''
    ].join('\n'));

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.status).toBe('failed');
    expect(result.violations.map((violation) => ({
      file: violation.file,
      kind: violation.kind,
      current: violation.current
    }))).toEqual(expect.arrayContaining([
      {
        file: '.nvmrc',
        kind: 'node-version-file',
        current: '(empty)'
      },
      {
        file: 'config/node-version.txt',
        kind: 'node-version-file',
        current: '(empty)'
      }
    ]));
  });

  test('fails empty or malformed tool-versions Node declarations', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, '.tool-versions', '\n');
    await write(root, 'packages/app/.tool-versions', 'nodejs   \n');
    await write(root, 'packages/python-only/.tool-versions', 'python 3.11.0\n');

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.status).toBe('failed');
    expect(result.violations.map((violation) => ({
      file: violation.file,
      kind: violation.kind,
      current: violation.current
    }))).toEqual(expect.arrayContaining([
      {
        file: '.tool-versions',
        kind: 'tool-versions',
        current: '(empty)'
      },
      {
        file: 'packages/app/.tool-versions',
        kind: 'tool-versions',
        current: '(empty)'
      },
      {
        file: 'packages/python-only/.tool-versions',
        kind: 'tool-versions',
        current: '(missing)'
      }
    ]));
    expect(result.summary).toContain("printf 'nodejs 24\\n' >> packages/python-only/.tool-versions");
  });

  test('fails unparsable Volta Node versions even when floating declarations are allowed', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({
      engines: { node: '>=22' },
      volta: { node: 'definitely-not-node' }
    }, null, 2)}\n`);

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: true,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.status).toBe('failed');
    expect(result.violations).toEqual([
      expect.objectContaining({
        file: 'package.json',
        kind: 'volta-node',
        current: 'definitely-not-node'
      })
    ]);
  });

  test('fails setup-node tool-versions references without nodejs declarations', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, '.tool-versions', 'python 3.11.0\n');
    await write(root, '.github/workflows/ci.yml', [
      'name: ci',
      'on: [pull_request]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version-file: .tool-versions',
      ''
    ].join('\n'));

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations[0]).toMatchObject({
      file: '.github/workflows/ci.yml',
      kind: 'setup-node-version-file',
      current: '.tool-versions'
    });
    expect(result.summary).toContain('Add "nodejs 24" to .tool-versions');
    expect(result.summary).toContain("printf 'nodejs 24\\n' >> .tool-versions");
    expect(result.summary).not.toContain("printf '24\\n' > .tool-versions");
  });

  test('fails unverifiable GitHub Action Node runtimes', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'action.yml', 'runs:\n  using: node\n  main: dist/index.cjs\n');

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations[0]).toMatchObject({
      file: 'action.yml',
      kind: 'action-runtime',
      current: 'node',
      title: 'GitHub Action runtime is not a pinned Node runtime'
    });
  });

  test('fails floating Docker Node base images', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'Dockerfile', 'FROM node\nFROM node:latest\nFROM node:bookworm AS build\n');

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations.map((violation) => ({
      file: violation.file,
      kind: violation.kind,
      current: violation.current,
      title: violation.title
    }))).toEqual([
      {
        file: 'Dockerfile',
        kind: 'docker-node',
        current: 'latest',
        title: 'Docker image uses a floating Node version'
      },
      {
        file: 'Dockerfile',
        kind: 'docker-node',
        current: 'latest',
        title: 'Docker image uses a floating Node version'
      },
      {
        file: 'Dockerfile',
        kind: 'docker-node',
        current: 'bookworm',
        title: 'Docker image uses an unverifiable Node version'
      }
    ]);
  });

  test('allows floating Docker Node base images when configured', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'Dockerfile', 'FROM node\nFROM node:latest\nFROM node:current\nFROM node:lts/*\n');

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: true,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.status).toBe('passed');
    expect(result.violations).toEqual([]);
  });

  test('allows floating version files and setup-node declarations when configured', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, '.nvmrc', 'node\n');
    await write(root, '.node-version', 'latest\n');
    await write(root, '.tool-versions', 'nodejs lts/*\n');
    await write(root, '.github/workflows/ci.yml', [
      'name: ci',
      'on: [pull_request]',
      'jobs:',
      '  direct:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version: node',
      '  matrix:',
      '    runs-on: ubuntu-latest',
      '    strategy:',
      '      matrix:',
      '        node: [lts/*, 24]',
      '    steps:',
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version: ${{ matrix.node }}',
      ''
    ].join('\n'));

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: true,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.status).toBe('passed');
    expect(result.violations).toEqual([]);
  });

  test('scans Dockerfile variants', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'Dockerfile.dev', 'FROM node:20-alpine\n');

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations[0]).toMatchObject({
      file: 'Dockerfile.dev',
      kind: 'docker-node',
      current: '20-alpine'
    });
  });

  test('scans registry-qualified official Node Docker images', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'Dockerfile', 'FROM docker.io/library/node:20\nFROM library/node:20-alpine\n');

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations.map((violation) => ({
      file: violation.file,
      kind: violation.kind,
      current: violation.current
    }))).toEqual([
      {
        file: 'Dockerfile',
        kind: 'docker-node',
        current: '20'
      },
      {
        file: 'Dockerfile',
        kind: 'docker-node',
        current: '20-alpine'
      }
    ]);
  });

  test('accepts setup-node version files that setup-node can parse', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, '.tool-versions', 'nodejs 24.1.0\n');
    await write(root, '.github/workflows/ci.yml', [
      'name: ci',
      'on: [pull_request]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version-file: package.json',
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version-file: .tool-versions',
      ''
    ].join('\n'));

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.status).toBe('passed');
    expect(result.violations).toEqual([]);
  });

  test('writes safe fixes for first-party Node declarations', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ name: 'service', engines: { node: '>=20' } }, null, 2)}\n`);
    await write(root, '.node-version', '20\n');
    await write(root, 'action.yml', 'runs:\n  using: node20\n  main: dist/index.cjs\n');
    await write(root, '.github/workflows/ci.yml', [
      'name: ci',
      'on: [pull_request]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version: 20',
      ''
    ].join('\n'));

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'write'
    });

    expect(result.fixedCount).toBe(4);
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toMatchObject({
      engines: { node: '>=22' }
    });
    expect(await readFile(join(root, '.node-version'), 'utf8')).toBe('24\n');
    expect(await readFile(join(root, 'action.yml'), 'utf8')).toContain('using: node24');
    expect(await readFile(join(root, '.github/workflows/ci.yml'), 'utf8')).toContain('node-version: 24');
  });

  test('checks setup-node matrix values and custom node-version-file references', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'config/node-version.txt', '20\n');
    await write(root, '.github/workflows/ci.yml', [
      'name: ci',
      'on: [pull_request]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    strategy:',
      '      matrix:',
      '        node: [20, 22]',
      '    steps:',
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version: ${{ matrix.node }}',
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version-file: config/node-version.txt',
      ''
    ].join('\n'));

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations.map((violation) => ({
      file: violation.file,
      kind: violation.kind,
      current: violation.current
    }))).toEqual([
      {
        file: '.github/workflows/ci.yml',
        kind: 'setup-node',
        current: '20'
      },
      {
        file: 'config/node-version.txt',
        kind: 'node-version-file',
        current: '20'
      }
    ]);
  });

  test('checks setup-node standard node-version-file references inside ignored paths', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'dist/.nvmrc', '20\n');
    await write(root, 'dist/.tool-versions', 'nodejs 20\n');
    await write(root, 'dist/package.json', `${JSON.stringify({ engines: { node: '>=20' } }, null, 2)}\n`);
    await write(root, '.github/workflows/ci.yml', [
      'name: ci',
      'on: [pull_request]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version-file: dist/.nvmrc',
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version-file: dist/.tool-versions',
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version-file: dist/package.json',
      ''
    ].join('\n'));

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations.map((violation) => ({
      file: violation.file,
      kind: violation.kind,
      current: violation.current
    }))).toEqual([
      {
        file: 'dist/.nvmrc',
        kind: 'node-version-file',
        current: '20'
      },
      {
        file: 'dist/.tool-versions',
        kind: 'tool-versions',
        current: '20'
      },
      {
        file: 'dist/package.json',
        kind: 'package-engines',
        current: '>=20'
      }
    ]);
    expect(result.summary).toContain('npm --prefix dist pkg set engines.node=">=22"');
  });

  test('fails when setup-node references a missing standard node-version-file', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, '.github/workflows/ci.yml', [
      'name: ci',
      'on: [pull_request]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version-file: .nvmrc',
      ''
    ].join('\n'));

    const result = await checkNodePolicy({
      rootDir: root,
      minimumNodeVersion: '22',
      preferredNodeVersion: '24',
      dependencyPolicy: 'compatible',
      scanDependencies: true,
      allowFloating: false,
      allowMissing: false,
      fixMode: 'none'
    });

    expect(result.violations[0]).toMatchObject({
      file: '.github/workflows/ci.yml',
      kind: 'setup-node-version-file',
      current: '.nvmrc'
    });
  });
});
