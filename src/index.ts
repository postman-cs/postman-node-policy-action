import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';

import { parse as parseYaml } from 'yaml';
import semver from 'semver';

export type DependencyPolicy = 'compatible' | 'floor';
export type FixMode = 'none' | 'write';
export type PolicyStatus = 'passed' | 'failed';

export interface PolicyOptions {
  rootDir: string;
  minimumNodeVersion: string;
  preferredNodeVersion: string;
  dependencyPolicy: DependencyPolicy;
  scanDependencies: boolean;
  allowFloating: boolean;
  allowMissing: boolean;
  fixMode: FixMode;
  ignorePaths?: string[];
}

export interface PolicyViolation {
  file: string;
  line: number;
  kind: string;
  title: string;
  message: string;
  current: string;
  expected: string;
  fixable: boolean;
  fix: string;
  packageName?: string;
}

export interface PolicyResult {
  status: PolicyStatus;
  checkedCount: number;
  violationCount: number;
  fixedCount: number;
  changedFiles: string[];
  violations: PolicyViolation[];
  summary: string;
}

interface ScanContext {
  rootDir: string;
  minimum: string;
  minimumMajor: number;
  minimumRange: string;
  minimumEngineRange: string;
  preferredMajor: string;
  dependencyMetadataLockDirs: Set<string>;
  options: PolicyOptions;
}

type MutableRecord = Record<string, unknown>;

const DEFAULT_IGNORES = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'node_modules'
]);

function normalizeRelPath(rootDir: string, fullPath: string): string {
  return relative(rootDir, fullPath).split(sep).join('/');
}

function toAbsolute(rootDir: string, relPath: string): string {
  return join(rootDir, ...relPath.split('/'));
}

function asRecord(value: unknown): MutableRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as MutableRecord
    : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function normalizeMinimumVersion(input: string): string {
  const parsed = semver.coerce(input);
  if (!parsed) {
    throw new Error(`minimum-node-version must be a Node version, got: ${input}`);
  }
  return parsed.version;
}

function majorOf(version: string): number {
  const parsed = semver.coerce(version);
  if (!parsed) {
    throw new Error(`Expected a Node version, got: ${version}`);
  }
  return parsed.major;
}

function minimumEngineRange(input: string): string {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return `>=${trimmed}`;
  }
  const parsed = semver.coerce(trimmed);
  if (!parsed) {
    throw new Error(`minimum-node-version must be a Node version, got: ${input}`);
  }
  const normalized = parsed.patch === 0 && parsed.minor === 0
    ? String(parsed.major)
    : parsed.version;
  return `>=${normalized}`;
}

function lineFor(contents: string, needle: string): number {
  const index = contents.indexOf(needle);
  if (index < 0) return 1;
  return contents.slice(0, index).split(/\r?\n/u).length;
}

function isFloatingNodeValue(value: string): boolean {
  return /^(node|latest|current|\*|lts\/\*)$/iu.test(value.trim());
}

function nodeVersionMeetsMinimum(value: string, minimumMajor: number): boolean | undefined {
  const trimmed = value.trim().replace(/^v/iu, '');
  const parsed = semver.coerce(trimmed);
  if (!parsed) return undefined;
  return parsed.major >= minimumMajor;
}

function nodeRuntimeMeetsMinimum(value: string, minimumMajor: number): boolean | undefined {
  const match = /^node(\d+)$/iu.exec(value.trim());
  if (!match) return undefined;
  return Number(match[1]) >= minimumMajor;
}

function rangeHasCompatibleVersion(range: string, minimumRange: string): boolean {
  try {
    return semver.intersects(range, minimumRange, { includePrerelease: true });
  } catch {
    return false;
  }
}

function rangeStaysAtOrAboveMinimum(range: string, minimumRange: string): boolean {
  try {
    const minimum = semver.minVersion(minimumRange);
    const rangeMinimum = semver.minVersion(range);
    return Boolean(minimum && rangeMinimum && semver.gte(rangeMinimum, minimum));
  } catch {
    return false;
  }
}

function hasLowerNodeRange(range: string, context: ScanContext): boolean {
  return !rangeStaysAtOrAboveMinimum(range, context.minimumRange);
}

function dependencyRangeViolates(range: string, context: ScanContext): boolean {
  if (context.options.dependencyPolicy === 'floor') {
    return !rangeStaysAtOrAboveMinimum(range, context.minimumRange);
  }
  return !rangeHasCompatibleVersion(range, context.minimumRange);
}

function makeViolation(input: Omit<PolicyViolation, 'fixable'> & { fixable?: boolean }): PolicyViolation {
  return {
    fixable: false,
    ...input
  };
}

function invalidStructuredFileViolation(
  file: string,
  kind: string,
  title: string,
  format: string
): PolicyViolation {
  return makeViolation({
    file,
    line: 1,
    kind,
    title,
    message: `${file} could not be parsed, so Node runtime policy cannot be verified.`,
    current: `invalid ${format}`,
    expected: `valid ${format}`,
    fixable: false,
    fix: `Fix the ${format} syntax, then rerun the policy check.`
  });
}

function hasDefaultIgnoredSegment(relPath: string): boolean {
  return relPath.split('/').some((segment) => DEFAULT_IGNORES.has(segment));
}

function normalizeScanPath(entry: string): string {
  const normalized = posix.normalize(entry.split(sep).join('/').replace(/^\/+/u, ''));
  return normalized === '.' ? '' : normalized.replace(/\/$/u, '');
}

function isOutsideScanRoot(relPath: string): boolean {
  return relPath === '..' || relPath.startsWith('../');
}

function normalizedIgnoredPaths(ignorePaths: string[] | undefined = []): Set<string> {
  return new Set(ignorePaths.map(normalizeScanPath));
}

function isIgnoredByFileScan(relPath: string, ignored: Set<string>): boolean {
  const firstSegment = relPath.split('/')[0] ?? relPath;
  return hasDefaultIgnoredSegment(relPath) ||
    ignored.has(relPath) ||
    ignored.has(firstSegment) ||
    [...ignored].some((ignore) => relPath.startsWith(`${ignore}/`));
}

function relDir(file: string): string {
  return dirname(file) === '.' ? '.' : dirname(file);
}

function npmPrefixForPackageFile(file: string): string {
  const packageDir = relDir(file);
  return packageDir === '.' ? 'npm' : `npm --prefix ${packageDir}`;
}

function packageEngineFixCommand(file: string, context: ScanContext): string {
  return `${npmPrefixForPackageFile(file)} pkg set engines.node="${context.minimumEngineRange}"`;
}

function packageLockRefreshCommand(file: string): string {
  return `${npmPrefixForPackageFile(file)} install --package-lock-only`;
}

function yarnMetadataInstallCommand(file: string): string {
  const command = 'yarn install --immutable || yarn install --frozen-lockfile';
  const packageDir = relDir(file);
  return packageDir === '.' ? command : `(cd ${packageDir} && (${command}))`;
}

function dependencyMetadataLockDirs(files: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) {
    const basename = file.split('/').at(-1) ?? '';
    if (/^package-lock\.json$/iu.test(basename) || /^pnpm-lock\.yaml$/iu.test(basename)) {
      dirs.add(relDir(file));
    }
  }
  return dirs;
}

function installedPackageDirsToScan(files: string[], metadataLockDirs: Set<string>): string[] {
  const dirs = new Set<string>();
  if (!metadataLockDirs.has('.')) {
    dirs.add('.');
  }
  for (const file of files) {
    if ((file.split('/').at(-1) ?? '') === 'yarn.lock') {
      const dir = relDir(file);
      if (!metadataLockDirs.has(dir)) {
        dirs.add(dir);
      }
    }
  }
  return [...dirs].sort();
}

async function listFiles(rootDir: string, ignorePaths: string[] = []): Promise<string[]> {
  const files: string[] = [];
  const ignored = normalizedIgnoredPaths(ignorePaths);

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = normalizeRelPath(rootDir, fullPath);
      if (isIgnoredByFileScan(relPath, ignored)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  }

  await walk(rootDir);
  return files.sort();
}

async function readText(rootDir: string, file: string): Promise<string> {
  return readFile(toAbsolute(rootDir, file), 'utf8');
}

function scanPackageJson(file: string, contents: string, context: ScanContext): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  let parsed: MutableRecord;
  try {
    parsed = JSON.parse(contents) as MutableRecord;
  } catch {
    return [makeViolation({
      file,
      line: 1,
      kind: 'invalid-package-json',
      title: 'Invalid package.json',
      message: `${file} could not be parsed, so Node engine policy cannot be verified.`,
      current: 'invalid JSON',
      expected: `valid package.json with engines.node ${context.minimumEngineRange} or newer`,
      fixable: false,
      fix: 'Fix the package.json syntax, then rerun the policy check.'
    })];
  }

  const engines = asRecord(parsed.engines);
  const engineRange = asString(engines?.node);
  if (!engineRange) {
    if (!context.options.allowMissing) {
      violations.push(makeViolation({
        file,
        line: lineFor(contents, '"engines"'),
        kind: 'package-engines',
        title: 'Missing Node engine policy',
        message: `${file} must declare engines.node ${context.minimumEngineRange} or newer.`,
        current: '(missing)',
        expected: context.minimumEngineRange,
        fixable: true,
        fix: packageEngineFixCommand(file, context)
      }));
    }
  } else if (hasLowerNodeRange(engineRange, context)) {
    violations.push(makeViolation({
      file,
      line: lineFor(contents, '"node"'),
      kind: 'package-engines',
      title: 'Package allows unsupported Node versions',
      message: `${file} declares engines.node ${engineRange}; require ${context.minimumEngineRange} or newer.`,
      current: engineRange,
      expected: context.minimumEngineRange,
      fixable: true,
      fix: packageEngineFixCommand(file, context)
    }));
  }

  const volta = asRecord(parsed.volta);
  const voltaNode = asString(volta?.node);
  if (voltaNode) {
    const isAllowedFloating = isFloatingNodeValue(voltaNode) && context.options.allowFloating;
    const meetsMinimum = isAllowedFloating ? true : nodeVersionMeetsMinimum(voltaNode, context.minimumMajor);
    if (meetsMinimum === false || meetsMinimum === undefined) {
      violations.push(makeViolation({
        file,
        line: lineFor(contents, '"volta"'),
        kind: 'volta-node',
        title: 'Volta pins unsupported Node',
        message: `${file} pins volta.node ${voltaNode}; use Node ${context.minimumEngineRange} or newer.`,
        current: voltaNode,
        expected: context.preferredMajor,
        fixable: false,
        fix: `Set volta.node to ${context.preferredMajor}.`
      }));
    }
  }

  return violations;
}

function scanNodeVersionFile(file: string, contents: string, context: ScanContext): PolicyViolation[] {
  const value = contents.split(/\s+/u).find(Boolean) ?? '';
  if (!value) {
    return [makeViolation({
      file,
      line: 1,
      kind: 'node-version-file',
      title: 'Empty Node version file',
      message: `${file} does not declare a Node version; set it to ${context.preferredMajor} or another version >=${context.minimumMajor}.`,
      current: '(empty)',
      expected: context.preferredMajor,
      fixable: true,
      fix: `printf '${context.preferredMajor}\\n' > ${file}`
    })];
  }
  if (isFloatingNodeValue(value)) {
    if (context.options.allowFloating) return [];
    return [makeViolation({
      file,
      line: 1,
      kind: 'node-version-file',
      title: 'Floating Node version',
      message: `${file} uses floating Node version ${value}; pin Node ${context.preferredMajor} or another version >=${context.minimumMajor}.`,
      current: value,
      expected: context.preferredMajor,
      fixable: true,
      fix: `printf '${context.preferredMajor}\\n' > ${file}`
    })];
  }
  const meetsMinimum = nodeVersionMeetsMinimum(value, context.minimumMajor);
  if (meetsMinimum === false || meetsMinimum === undefined) {
    return [makeViolation({
      file,
      line: 1,
      kind: 'node-version-file',
      title: 'Node version file pins unsupported Node',
      message: `${file} pins Node ${value}; use Node ${context.minimumEngineRange} or newer.`,
      current: value,
      expected: context.preferredMajor,
      fixable: true,
      fix: `printf '${context.preferredMajor}\\n' > ${file}`
    })];
  }
  return [];
}

function scanToolVersions(file: string, contents: string, context: ScanContext): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  if (!contents.trim()) {
    violations.push(makeViolation({
      file,
      line: 1,
      kind: 'tool-versions',
      title: 'Empty tool-versions file',
      message: `${file} does not declare a nodejs version; add nodejs ${context.preferredMajor} or another version >=${context.minimumMajor}.`,
      current: '(empty)',
      expected: context.preferredMajor,
      fixable: false,
      fix: `Add "nodejs ${context.preferredMajor}" to ${file}.`
    }));
    return violations;
  }
  const lines = contents.split(/\r?\n/u);
  let hasNodeDeclaration = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.replace(/\s+#.*$/u, '').trim();
    if (!trimmed) continue;
    const match = /^nodejs(?:\s+(\S+)(?:\s+.*)?)?$/u.exec(trimmed);
    if (!match) continue;
    hasNodeDeclaration = true;
    const value = match[1] ?? '';
    if (!value) {
      violations.push(makeViolation({
        file,
        line: index + 1,
        kind: 'tool-versions',
        title: 'Empty tool-versions Node declaration',
        message: `${file} declares nodejs without a version; set it to ${context.preferredMajor} or another version >=${context.minimumMajor}.`,
        current: '(empty)',
        expected: context.preferredMajor,
        fixable: false,
        fix: `Set nodejs to ${context.preferredMajor}.`
      }));
      continue;
    }
    if (isFloatingNodeValue(value)) {
      if (context.options.allowFloating) continue;
      violations.push(makeViolation({
        file,
        line: index + 1,
        kind: 'tool-versions',
        title: 'Floating Node version',
        message: `${file} uses floating nodejs version ${value}; pin Node ${context.preferredMajor} or another version >=${context.minimumMajor}.`,
        current: value,
        expected: context.preferredMajor,
        fixable: false,
        fix: `Set nodejs to ${context.preferredMajor}.`
      }));
      continue;
    }
    const meetsMinimum = nodeVersionMeetsMinimum(value, context.minimumMajor);
    if (meetsMinimum === false || meetsMinimum === undefined) {
      violations.push(makeViolation({
        file,
        line: index + 1,
        kind: 'tool-versions',
        title: 'Tool versions pin unsupported Node',
        message: `${file} pins nodejs ${value}; use Node ${context.minimumEngineRange} or newer.`,
        current: value,
        expected: context.preferredMajor,
        fixable: false,
        fix: `Set nodejs to ${context.preferredMajor}.`
      }));
    }
  }
  if (!hasNodeDeclaration) {
    violations.push(makeViolation({
      file,
      line: 1,
      kind: 'tool-versions',
      title: 'Missing tool-versions Node declaration',
      message: `${file} does not declare a nodejs version; add nodejs ${context.preferredMajor} or another version >=${context.minimumMajor}.`,
      current: '(missing)',
      expected: context.preferredMajor,
      fixable: false,
      fix: `Add "nodejs ${context.preferredMajor}" to ${file}.`
    }));
  }
  return violations;
}

function toolVersionsHasNodeDeclaration(contents: string): boolean {
  return contents
    .split(/\r?\n/u)
    .some((line) => /^nodejs(?:\s|$)/u.test(line.replace(/\s+#.*$/u, '').trim()));
}

function scanActionMetadata(file: string, contents: string, context: ScanContext): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  let parsed: unknown;
  try {
    parsed = parseYaml(contents);
  } catch {
    return [invalidStructuredFileViolation(file, 'invalid-action-yaml', 'Invalid GitHub Action metadata', 'YAML')];
  }
  const runs = asRecord(asRecord(parsed)?.runs);
  const using = asString(runs?.using);
  if (!using) return violations;
  const meetsMinimum = nodeRuntimeMeetsMinimum(using, context.minimumMajor);
  if (meetsMinimum === undefined && /^node/iu.test(using.trim())) {
    violations.push(makeViolation({
      file,
      line: lineFor(contents, 'using:'),
      kind: 'action-runtime',
      title: 'GitHub Action runtime is not a pinned Node runtime',
      message: `${file} uses ${using}; GitHub JavaScript actions must use node${context.preferredMajor}.`,
      current: using,
      expected: `node${context.preferredMajor}`,
      fixable: true,
      fix: `Set runs.using to node${context.preferredMajor}.`
    }));
  }
  if (meetsMinimum === false) {
    violations.push(makeViolation({
      file,
      line: lineFor(contents, 'using:'),
      kind: 'action-runtime',
      title: 'GitHub Action runtime is below policy',
      message: `${file} runs on ${using}; GitHub JavaScript actions must use node${context.preferredMajor}.`,
      current: using,
      expected: `node${context.preferredMajor}`,
      fixable: true,
      fix: `Set runs.using to node${context.preferredMajor}.`
    }));
  }
  return violations;
}

function matrixValuesFor(job: unknown, expression: string): string[] {
  const match = /^\s*\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}\s*$/u.exec(expression);
  if (!match) return [];
  const matrixKey = match[1] ?? '';
  const matrix = asRecord(asRecord(asRecord(job)?.strategy)?.matrix);
  const value = matrix?.[matrixKey];
  if (Array.isArray(value)) {
    return value.map(asString).filter((entry): entry is string => Boolean(entry));
  }
  const single = asString(value);
  return single ? [single] : [];
}

async function scanWorkflow(file: string, contents: string, context: ScanContext): Promise<PolicyViolation[]> {
  const violations: PolicyViolation[] = [];
  let parsed: unknown;
  try {
    parsed = parseYaml(contents);
  } catch {
    return [invalidStructuredFileViolation(file, 'invalid-workflow-yaml', 'Invalid GitHub workflow YAML', 'YAML')];
  }
  const jobs = asRecord(asRecord(parsed)?.jobs);
  if (!jobs) return violations;

  for (const job of Object.values(jobs)) {
    const steps = asRecord(job)?.steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      const record = asRecord(step);
      const uses = asString(record?.uses);
      if (!uses || !/^actions\/setup-node@/iu.test(uses)) continue;
      const withBlock = asRecord(record?.with);
      const nodeVersion = asString(withBlock?.['node-version']);
      if (nodeVersion) {
        const trimmed = nodeVersion.trim();
        const matrixValues = matrixValuesFor(job, trimmed);
        const valuesToCheck = matrixValues.length > 0 ? matrixValues : [trimmed];
        for (const valueToCheck of valuesToCheck) {
          if (isFloatingNodeValue(valueToCheck)) {
            if (!context.options.allowFloating) {
              violations.push(makeViolation({
                file,
                line: lineFor(contents, 'node-version:'),
                kind: 'setup-node',
                title: 'setup-node uses a floating Node version',
                message: `${file} uses setup-node node-version ${valueToCheck}; pin Node ${context.preferredMajor} or another version >=${context.minimumMajor}.`,
                current: valueToCheck,
                expected: context.preferredMajor,
                fixable: matrixValues.length === 0,
                fix: matrixValues.length === 0
                  ? `Set node-version to ${context.preferredMajor}.`
                  : `Remove ${valueToCheck} from the setup-node matrix or replace it with ${context.preferredMajor}.`
              }));
            }
            continue;
          }
          const meetsMinimum = nodeVersionMeetsMinimum(valueToCheck, context.minimumMajor);
          if (meetsMinimum === false || meetsMinimum === undefined) {
            violations.push(makeViolation({
              file,
              line: lineFor(contents, 'node-version:'),
              kind: 'setup-node',
              title: 'setup-node pins unsupported Node',
              message: `${file} uses setup-node node-version ${valueToCheck}; use Node ${context.minimumEngineRange} or newer.`,
              current: valueToCheck,
              expected: context.preferredMajor,
              fixable: matrixValues.length === 0,
              fix: matrixValues.length === 0
                ? `Set node-version to ${context.preferredMajor}.`
                : `Remove Node ${valueToCheck} from the setup-node matrix or replace it with ${context.preferredMajor}.`
            }));
          }
        }
      }
      const nodeVersionFile = asString(withBlock?.['node-version-file']);
      if (nodeVersionFile) {
        const versionFile = normalizeScanPath(nodeVersionFile.trim());
        if (isOutsideScanRoot(versionFile)) {
          violations.push(makeViolation({
            file,
            line: lineFor(contents, 'node-version-file:'),
            kind: 'setup-node-version-file',
            title: 'setup-node version file is outside the repository',
            message: `${file} references ${versionFile}, but Node runtime policy only checks files inside the repository root.`,
            current: versionFile,
            expected: context.preferredMajor,
            fixable: false,
            fix: `Move the Node version file into the repository and reference it with a path like .nvmrc.`
          }));
          continue;
        }
        const versionBasename = versionFile.split('/').at(-1) ?? versionFile;
        const standardVersionFile = ['.nvmrc', '.node-version', '.tool-versions', 'package.json'].includes(versionBasename);
        const referencedFileIsIgnored = isIgnoredByFileScan(versionFile, normalizedIgnoredPaths(context.options.ignorePaths));
        try {
          const versionContents = await readText(context.rootDir, versionFile);
          if (versionBasename === '.tool-versions' && versionContents.trim() && !toolVersionsHasNodeDeclaration(versionContents)) {
            violations.push(makeViolation({
              file,
              line: lineFor(contents, 'node-version-file:'),
              kind: 'setup-node-version-file',
              title: 'setup-node version file lacks nodejs entry',
              message: `${file} references ${versionFile}, but that file does not declare nodejs.`,
              current: versionFile,
              expected: context.preferredMajor,
              fixable: false,
              fix: `Add "nodejs ${context.preferredMajor}" to ${versionFile}.`
            }));
          } else if (!standardVersionFile || referencedFileIsIgnored) {
            if (versionBasename === 'package.json') {
              violations.push(...scanPackageJson(versionFile, versionContents, context));
            } else if (versionBasename === '.tool-versions') {
              violations.push(...scanToolVersions(versionFile, versionContents, context));
            } else {
              violations.push(...scanNodeVersionFile(versionFile, versionContents, context));
            }
          }
        } catch {
          violations.push(makeViolation({
            file,
            line: lineFor(contents, 'node-version-file:'),
            kind: 'setup-node-version-file',
            title: 'setup-node references a missing Node version file',
            message: `${file} references ${versionFile}, but that file could not be read.`,
            current: versionFile,
            expected: context.preferredMajor,
            fixable: false,
            fix: `Create ${versionFile} with Node ${context.preferredMajor}.`
          }));
        }
      }
    }
  }

  return violations;
}

function scanDockerfile(file: string, contents: string, context: ScanContext): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const lines = contents.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const match = /^\s*FROM\s+(?:--platform=\S+\s+)?(?:(?:docker\.io|index\.docker\.io)\/)?(?:library\/)?node(?::([^\s@]+))?(?=[\s@]|$)/iu.exec(line);
    if (!match) continue;
    const value = match[1] ?? 'latest';
    if (isFloatingNodeValue(value)) {
      if (!context.options.allowFloating) {
        violations.push(makeViolation({
          file,
          line: index + 1,
          kind: 'docker-node',
          title: 'Docker image uses a floating Node version',
          message: `${file} uses node:${value}; pin Node ${context.preferredMajor} or another version ${context.minimumEngineRange} or newer.`,
          current: value,
          expected: context.preferredMajor,
          fixable: false,
          fix: `Use a node:${context.preferredMajor} base image.`
        }));
      }
      continue;
    }
    const meetsMinimum = nodeVersionMeetsMinimum(value, context.minimumMajor);
    if (meetsMinimum === undefined) {
      violations.push(makeViolation({
        file,
        line: index + 1,
        kind: 'docker-node',
        title: 'Docker image uses an unverifiable Node version',
        message: `${file} uses node:${value}; use an explicit Node ${context.minimumEngineRange} or newer base image.`,
        current: value,
        expected: context.preferredMajor,
        fixable: false,
        fix: `Use a node:${context.preferredMajor} base image.`
      }));
      continue;
    }
    if (meetsMinimum === false) {
      violations.push(makeViolation({
        file,
        line: index + 1,
        kind: 'docker-node',
        title: 'Docker image uses unsupported Node',
        message: `${file} uses node:${value}; use Node ${context.minimumEngineRange} or newer.`,
        current: value,
        expected: context.preferredMajor,
        fixable: false,
        fix: `Use a node:${context.preferredMajor} base image.`
      }));
    }
  }
  return violations;
}

function packageNameFromLockPath(lockPath: string, metadata: MutableRecord): string {
  const declared = asString(metadata.name);
  if (declared) return declared;
  const segments = lockPath.split('/');
  const lastNodeModules = segments.lastIndexOf('node_modules');
  if (lastNodeModules >= 0) {
    const first = segments[lastNodeModules + 1] ?? lockPath;
    if (first.startsWith('@')) {
      return first + '/' + (segments[lastNodeModules + 2] ?? '');
    }
    return first;
  }
  return lockPath;
}

function scanPackageLock(file: string, contents: string, context: ScanContext): PolicyViolation[] {
  if (!context.options.scanDependencies) return [];
  const violations: PolicyViolation[] = [];
  let parsed: MutableRecord;
  try {
    parsed = JSON.parse(contents) as MutableRecord;
  } catch {
    return [invalidStructuredFileViolation(file, 'invalid-package-lock', 'Invalid package-lock.json', 'JSON')];
  }
  const packages = asRecord(parsed.packages);
  if (!packages) {
    return [makeViolation({
      file,
      line: 1,
      kind: 'unsupported-package-lock',
      title: 'package-lock.json lacks dependency engine metadata',
      message: `${file} does not include packages metadata, so dependency Node engines cannot be verified from the lockfile.`,
      current: file,
      expected: 'package-lock.json lockfileVersion 2 or 3 with packages metadata',
      fixable: false,
      fix: 'Regenerate package-lock.json with a current npm version, then rerun the policy check.'
    })];
  }
  for (const [lockPath, metadata] of Object.entries(packages)) {
    if (!lockPath || !lockPath.includes('node_modules')) continue;
    const packageRecord = asRecord(metadata);
    const range = asString(asRecord(packageRecord?.engines)?.node);
    if (!range || !dependencyRangeViolates(range, context)) continue;
    const packageName = packageNameFromLockPath(lockPath, packageRecord ?? {});
    violations.push(makeViolation({
      file,
      line: lineFor(contents, `"${lockPath}"`),
      kind: 'dependency-engine',
      title: 'Dependency Node engine violates policy',
      message: `${packageName} declares engines.node ${range}; dependency policy requires ${context.options.dependencyPolicy === 'floor' ? context.minimumEngineRange : `compatibility with ${context.minimumEngineRange}`}.`,
      current: range,
      expected: context.options.dependencyPolicy === 'floor' ? context.minimumEngineRange : `compatible with ${context.minimumEngineRange}`,
      fixable: false,
      fix: `Upgrade or replace ${packageName}, or use package-manager overrides if a newer compatible transitive version exists.`,
      packageName
    }));
  }
  return violations;
}

function scanPnpmLock(file: string, contents: string, context: ScanContext): PolicyViolation[] {
  if (!context.options.scanDependencies) return [];
  const violations: PolicyViolation[] = [];
  let parsed: unknown;
  try {
    parsed = parseYaml(contents);
  } catch {
    return [invalidStructuredFileViolation(file, 'invalid-pnpm-lock', 'Invalid pnpm lockfile', 'YAML')];
  }
  const packages = asRecord(asRecord(parsed)?.packages);
  if (!packages) return violations;
  for (const [lockPath, metadata] of Object.entries(packages)) {
    const packageRecord = asRecord(metadata);
    const range = asString(asRecord(packageRecord?.engines)?.node);
    if (!range || !dependencyRangeViolates(range, context)) continue;
    const packageName = lockPath.replace(/^\/?/u, '').replace(/@\d[^/]*$/u, '');
    violations.push(makeViolation({
      file,
      line: lineFor(contents, lockPath),
      kind: 'dependency-engine',
      title: 'Dependency Node engine violates policy',
      message: `${packageName} declares engines.node ${range}; dependency policy requires ${context.options.dependencyPolicy === 'floor' ? context.minimumEngineRange : `compatibility with ${context.minimumEngineRange}`}.`,
      current: range,
      expected: context.options.dependencyPolicy === 'floor' ? context.minimumEngineRange : `compatible with ${context.minimumEngineRange}`,
      fixable: false,
      fix: `Upgrade or replace ${packageName}, or use pnpm overrides if a newer compatible transitive version exists.`,
      packageName
    }));
  }
  return violations;
}

async function hasInstalledPackages(rootDir: string, packageDir = '.'): Promise<boolean> {
  try {
    const baseDir = packageDir === '.' ? rootDir : toAbsolute(rootDir, packageDir);
    return (await stat(join(baseDir, 'node_modules'))).isDirectory();
  } catch {
    return false;
  }
}

async function scanYarnLock(file: string, context: ScanContext): Promise<PolicyViolation[]> {
  const packageDir = relDir(file);
  if (
    !context.options.scanDependencies ||
    context.dependencyMetadataLockDirs.has(packageDir) ||
    await hasInstalledPackages(context.rootDir, packageDir)
  ) return [];
  return [makeViolation({
    file,
    line: 1,
    kind: 'unsupported-lockfile',
    title: 'Yarn dependency engines require installed manifests',
    message: 'yarn.lock does not contain dependency engines, so the action cannot verify transitive Node compatibility from the lockfile alone.',
    current: file,
    expected: 'node_modules package manifests, package-lock.json, or pnpm-lock.yaml with engine metadata',
    fixable: false,
    fix: 'Run a frozen Yarn install before this action, or use an npm/pnpm lockfile that includes dependency engine metadata.'
  })];
}

async function packageManifestExists(packageDir: string): Promise<boolean> {
  try {
    return (await stat(join(packageDir, 'package.json'))).isFile();
  } catch {
    return false;
  }
}

async function collectInstalledPackageManifests(rootDir: string, packageDir = '.'): Promise<string[]> {
  const manifests: string[] = [];

  async function collectPackage(packageDir: string): Promise<void> {
    if (await packageManifestExists(packageDir)) {
      manifests.push(normalizeRelPath(rootDir, join(packageDir, 'package.json')));
    }
    const nestedNodeModules = join(packageDir, 'node_modules');
    try {
      if ((await stat(nestedNodeModules)).isDirectory()) {
        await collectNodeModules(nestedNodeModules);
      }
    } catch {
      // Most packages do not have nested dependencies on disk.
    }
  }

  async function collectNodeModules(nodeModulesDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(nodeModulesDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      const fullPath = join(nodeModulesDir, entry.name);
      if (entry.name.startsWith('@')) {
        const scopedEntries = await readdir(fullPath, { withFileTypes: true });
        for (const scopedEntry of scopedEntries) {
          if (scopedEntry.isDirectory()) {
            await collectPackage(join(fullPath, scopedEntry.name));
          }
        }
        continue;
      }
      await collectPackage(fullPath);
    }
  }

  const baseDir = packageDir === '.' ? rootDir : toAbsolute(rootDir, packageDir);
  await collectNodeModules(join(baseDir, 'node_modules'));
  return manifests.sort();
}

async function scanInstalledPackageManifests(context: ScanContext, packageDirs: string[]): Promise<PolicyViolation[]> {
  if (!context.options.scanDependencies) return [];
  const violations: PolicyViolation[] = [];
  const manifests = new Set<string>();
  for (const packageDir of packageDirs) {
    for (const manifest of await collectInstalledPackageManifests(context.rootDir, packageDir)) {
      manifests.add(manifest);
    }
  }
  for (const file of manifests) {
    const contents = await readText(context.rootDir, file);
    let parsed: MutableRecord;
    try {
      parsed = JSON.parse(contents) as MutableRecord;
    } catch {
      violations.push(invalidStructuredFileViolation(
        file,
        'invalid-installed-package-json',
        'Invalid installed package manifest',
        'JSON'
      ));
      continue;
    }
    const range = asString(asRecord(parsed.engines)?.node);
    if (!range || !dependencyRangeViolates(range, context)) continue;
    const packageName = asString(parsed.name) ?? file.replace(/\/package\.json$/u, '');
    violations.push(makeViolation({
      file,
      line: lineFor(contents, '"node"'),
      kind: 'dependency-engine',
      title: 'Installed dependency Node engine violates policy',
      message: `${packageName} declares engines.node ${range}; dependency policy requires ${context.options.dependencyPolicy === 'floor' ? context.minimumEngineRange : `compatibility with ${context.minimumEngineRange}`}.`,
      current: range,
      expected: context.options.dependencyPolicy === 'floor' ? context.minimumEngineRange : `compatible with ${context.minimumEngineRange}`,
      fixable: false,
      fix: `Upgrade or replace ${packageName}, or use package-manager overrides if a newer compatible transitive version exists.`,
      packageName
    }));
  }
  return violations;
}

async function scanFile(file: string, context: ScanContext): Promise<PolicyViolation[]> {
  const contents = await readText(context.rootDir, file);
  const basename = file.split('/').at(-1) ?? file;

  if (basename === 'package.json') return scanPackageJson(file, contents, context);
  if (basename === '.nvmrc' || basename === '.node-version') return scanNodeVersionFile(file, contents, context);
  if (basename === '.tool-versions') return scanToolVersions(file, contents, context);
  if (/^action\.ya?ml$/iu.test(basename)) return scanActionMetadata(file, contents, context);
  if (/^package-lock\.json$/iu.test(basename)) return scanPackageLock(file, contents, context);
  if (/^pnpm-lock\.yaml$/iu.test(basename)) return scanPnpmLock(file, contents, context);
  if (/^yarn\.lock$/iu.test(basename)) return scanYarnLock(file, context);
  if (/\.github\/workflows\/[^/]+\.ya?ml$/iu.test(file)) return scanWorkflow(file, contents, context);
  if (/^(?:Dockerfile|Containerfile)(?:[.-].*)?$/u.test(basename)) return scanDockerfile(file, contents, context);
  return [];
}

async function applyFixes(violations: PolicyViolation[], context: ScanContext): Promise<string[]> {
  const changed = new Set<string>();

  for (const violation of violations) {
    if (!violation.fixable) continue;
    const fullPath = toAbsolute(context.rootDir, violation.file);
    const contents = await readFile(fullPath, 'utf8');

    if (violation.kind === 'package-engines') {
      const parsed = JSON.parse(contents) as MutableRecord;
      const engines = asRecord(parsed.engines) ?? {};
      engines.node = context.minimumEngineRange;
      parsed.engines = engines;
      await writeFile(fullPath, `${JSON.stringify(parsed, null, 2)}\n`);
      changed.add(violation.file);
      continue;
    }

    if (violation.kind === 'node-version-file') {
      await writeFile(fullPath, `${context.preferredMajor}\n`);
      changed.add(violation.file);
      continue;
    }

    if (violation.kind === 'setup-node') {
      const updated = contents.replace(
        /(\bnode-version:\s*)(['"]?)[^\s'"]+(\2)/u,
        `$1$2${context.preferredMajor}$3`
      );
      if (updated !== contents) {
        await writeFile(fullPath, updated);
        changed.add(violation.file);
      }
      continue;
    }

    if (violation.kind === 'action-runtime') {
      const updated = contents.replace(/(\busing:\s*)(['"]?)node(?:\d+)?(\2)/iu, `$1$2node${context.preferredMajor}$3`);
      if (updated !== contents) {
        await writeFile(fullPath, updated);
        changed.add(violation.file);
      }
    }
  }

  return [...changed].sort();
}

function formatSummary(result: Omit<PolicyResult, 'summary'>, context: ScanContext, initialViolationCount: number): string {
  const lines: string[] = [];
  lines.push(result.status === 'passed' ? '## Node Runtime Policy Passed' : '## Node Runtime Policy Failed');
  lines.push('');
  lines.push(`Minimum: Node ${context.minimumEngineRange}`);
  lines.push(`Preferred: Node ${context.preferredMajor}`);
  lines.push(`Dependency policy: ${context.options.dependencyPolicy}`);
  lines.push('');
  lines.push(`Checked files: ${result.checkedCount}`);
  lines.push(`Violations: ${result.violationCount}`);
  if (result.fixedCount > 0) {
    lines.push(`Fixed files: ${result.fixedCount}`);
  }
  if (initialViolationCount > 0 && result.violations.length === 0 && result.fixedCount > 0) {
    lines.push('');
    lines.push('Safe fixes were written locally. Commit the changed files or run the workflow with a pull-request remediation step.');
  }
  if (result.violations.length > 0) {
    lines.push('');
    lines.push('| File | Current | Required | Fix |');
    lines.push('| --- | --- | --- | --- |');
    for (const violation of result.violations) {
      lines.push(`| ${violation.file}:${violation.line} | ${violation.current.replace(/\|/gu, '\\|')} | ${violation.expected.replace(/\|/gu, '\\|')} | ${violation.fix.replace(/\|/gu, '\\|')} |`);
    }
    lines.push('');
    const commands = suggestedCommandsForViolations(result.violations, context);
    if (commands.length > 0) {
      lines.push('### Suggested Commands');
      lines.push('');
      lines.push('```sh');
      lines.push(...commands);
      lines.push('```');
    }
  }
  return `${lines.join('\n')}\n`;
}

function suggestedCommandsForViolations(violations: PolicyViolation[], context: ScanContext): string[] {
  const commands = new Set<string>();
  for (const violation of violations) {
    if (violation.kind === 'package-engines') {
      commands.add(packageEngineFixCommand(violation.file, context));
      commands.add(packageLockRefreshCommand(violation.file));
    } else if (violation.kind === 'node-version-file') {
      commands.add("printf '" + context.preferredMajor + "\\n' > " + violation.file);
    } else if (violation.kind === 'setup-node-version-file') {
      if (isOutsideScanRoot(normalizeScanPath(violation.current))) {
        commands.add('# ' + violation.fix);
      } else if (violation.current.endsWith('.tool-versions')) {
        commands.add("printf 'nodejs " + context.preferredMajor + "\\n' >> " + violation.current);
      } else {
        commands.add("printf '" + context.preferredMajor + "\\n' > " + violation.current);
      }
    } else if (violation.kind === 'unsupported-lockfile') {
      commands.add(yarnMetadataInstallCommand(violation.file));
    } else if (violation.kind === 'unsupported-package-lock') {
      commands.add('npm install --package-lock-only');
    } else if (violation.kind === 'tool-versions' && violation.current === '(missing)') {
      commands.add("printf 'nodejs " + context.preferredMajor + "\\n' >> " + violation.file);
    } else if (violation.kind === 'dependency-engine') {
      commands.add('# ' + violation.fix);
    } else if (violation.fix) {
      commands.add('# ' + violation.fix);
    }
  }
  return [...commands];
}

export async function checkNodePolicy(options: PolicyOptions): Promise<PolicyResult> {
  const rootDir = options.rootDir;
  const rootStat = await stat(rootDir);
  if (!rootStat.isDirectory()) {
    throw new Error(`rootDir must be a directory: ${rootDir}`);
  }

  const minimum = normalizeMinimumVersion(options.minimumNodeVersion);
  const files = await listFiles(rootDir, options.ignorePaths);
  const initialDependencyMetadataLockDirs = dependencyMetadataLockDirs(files);
  const context: ScanContext = {
    rootDir,
    minimum,
    minimumMajor: majorOf(minimum),
    minimumRange: `>=${minimum}`,
    minimumEngineRange: minimumEngineRange(options.minimumNodeVersion),
    preferredMajor: String(majorOf(options.preferredNodeVersion)),
    dependencyMetadataLockDirs: initialDependencyMetadataLockDirs,
    options
  };

  let violations = (await Promise.all(files.map((file) => scanFile(file, context)))).flat();
  violations.push(...await scanInstalledPackageManifests(context, installedPackageDirsToScan(files, initialDependencyMetadataLockDirs)));
  violations = violations.sort((left, right) => `${left.file}:${left.kind}`.localeCompare(`${right.file}:${right.kind}`));
  const initialViolationCount = violations.length;

  let changedFiles: string[] = [];
  if (options.fixMode === 'write' && violations.some((violation) => violation.fixable)) {
    changedFiles = await applyFixes(violations, context);
    const rescannedFiles = await listFiles(rootDir, options.ignorePaths);
    const rescannedDependencyMetadataLockDirs = dependencyMetadataLockDirs(rescannedFiles);
    context.dependencyMetadataLockDirs = rescannedDependencyMetadataLockDirs;
    violations = (await Promise.all(rescannedFiles.map((file) => scanFile(file, context)))).flat();
    violations.push(...await scanInstalledPackageManifests(context, installedPackageDirsToScan(rescannedFiles, rescannedDependencyMetadataLockDirs)));
    violations = violations
      .sort((left, right) => `${left.file}:${left.kind}`.localeCompare(`${right.file}:${right.kind}`));
  }

  const resultWithoutSummary: Omit<PolicyResult, 'summary'> = {
    status: violations.length > 0 ? 'failed' : 'passed',
    checkedCount: files.length,
    violationCount: violations.length,
    fixedCount: changedFiles.length,
    changedFiles,
    violations
  };

  return {
    ...resultWithoutSummary,
    summary: formatSummary(resultWithoutSummary, context, initialViolationCount)
  };
}

export function readBooleanInput(value: string | undefined, defaultValue: boolean): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Expected boolean input, got: ${value}`);
}

export function parseListInput(value: string | undefined): string[] {
  return String(value ?? '')
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export interface ActionInputReader {
  getInput(name: string): string;
}

export function readPolicyOptionsFromAction(input: ActionInputReader, rootDir = process.cwd()): PolicyOptions {
  const dependencyPolicy = input.getInput('dependency-policy') || 'floor';
  if (dependencyPolicy !== 'compatible' && dependencyPolicy !== 'floor') {
    throw new Error('dependency-policy must be one of: compatible, floor');
  }
  const fixMode = input.getInput('fix-mode') || 'none';
  if (fixMode !== 'none' && fixMode !== 'write') {
    throw new Error('fix-mode must be one of: none, write');
  }
  return {
    rootDir,
    minimumNodeVersion: input.getInput('minimum-node-version') || '22',
    preferredNodeVersion: input.getInput('preferred-node-version') || '24',
    dependencyPolicy,
    scanDependencies: readBooleanInput(input.getInput('scan-dependencies'), true),
    allowFloating: readBooleanInput(input.getInput('allow-floating'), false),
    allowMissing: readBooleanInput(input.getInput('allow-missing'), false),
    fixMode,
    ignorePaths: parseListInput(input.getInput('ignore-paths'))
  };
}

export interface CoreLike {
  error(message: string, properties?: { title?: string; file?: string; startLine?: number }): void;
  info(message: string): void;
  setFailed(message: string): void;
  setOutput(name: string, value: string): void;
  summary?: {
    addRaw(text: string): { write(): Promise<unknown> };
  };
}

export async function runNodePolicyAction(options: PolicyOptions, core: CoreLike): Promise<PolicyResult> {
  const result = await checkNodePolicy(options);
  for (const violation of result.violations) {
    core.error(violation.message, {
      title: violation.title,
      file: violation.file,
      startLine: violation.line
    });
  }
  core.setOutput('status', result.status);
  core.setOutput('checked-count', String(result.checkedCount));
  core.setOutput('violation-count', String(result.violationCount));
  core.setOutput('fixed-count', String(result.fixedCount));
  core.setOutput('changed-files-json', JSON.stringify(result.changedFiles));
  core.setOutput('summary-json', JSON.stringify({
    status: result.status,
    checkedCount: result.checkedCount,
    violationCount: result.violationCount,
    fixedCount: result.fixedCount,
    changedFiles: result.changedFiles,
    violations: result.violations
  }));
  if (core.summary) {
    await core.summary.addRaw(result.summary).write();
  } else {
    core.info(result.summary);
  }
  if (result.status === 'failed') {
    core.setFailed(`Node runtime policy failed with ${result.violationCount} violation${result.violationCount === 1 ? '' : 's'}.`);
  }
  return result;
}

export async function ensureParentDirectory(path: string): Promise<void> {
  await import('node:fs/promises').then(({ mkdir }) => mkdir(dirname(path), { recursive: true }));
}
