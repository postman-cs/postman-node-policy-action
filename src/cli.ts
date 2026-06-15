import { checkNodePolicy, parseListInput, readBooleanInput, type DependencyPolicy, type FixMode } from './index.js';

function readFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === `--${name}`) {
      return argv[index + 1];
    }
    if (value?.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const dependencyPolicy = (readFlag(process.argv, 'dependency-policy') ?? 'floor') as DependencyPolicy;
  const fixMode = (readFlag(process.argv, 'fix-mode') ?? 'none') as FixMode;
  if (dependencyPolicy !== 'compatible' && dependencyPolicy !== 'floor') {
    throw new Error('dependency-policy must be one of: compatible, floor');
  }
  if (fixMode !== 'none' && fixMode !== 'write') {
    throw new Error('fix-mode must be one of: none, write');
  }
  const result = await checkNodePolicy({
    rootDir: readFlag(process.argv, 'root') ?? process.cwd(),
    minimumNodeVersion: readFlag(process.argv, 'minimum-node-version') ?? '22',
    preferredNodeVersion: readFlag(process.argv, 'preferred-node-version') ?? '24',
    dependencyPolicy,
    scanDependencies: readBooleanInput(readFlag(process.argv, 'scan-dependencies'), true),
    allowFloating: readBooleanInput(readFlag(process.argv, 'allow-floating'), false),
    allowMissing: readBooleanInput(readFlag(process.argv, 'allow-missing'), false),
    fixMode,
    ignorePaths: parseListInput(readFlag(process.argv, 'ignore-paths'))
  });
  process.stdout.write(result.summary);
  if (result.status === 'failed') {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
});
