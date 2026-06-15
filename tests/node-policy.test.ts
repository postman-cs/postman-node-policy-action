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

  test('fails dependency engine ranges that exclude Node 22 and ignores compatible lower floors by default', async () => {
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
      dependencyPolicy: 'compatible',
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

  test('fails floating Docker Node base images', async () => {
    const root = await makeRepo();
    await write(root, 'package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`);
    await write(root, 'Dockerfile', 'FROM node:latest\nFROM node:bookworm AS build\n');

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
        current: 'bookworm',
        title: 'Docker image uses an unverifiable Node version'
      }
    ]);
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
