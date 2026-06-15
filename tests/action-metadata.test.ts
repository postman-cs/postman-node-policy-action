import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, test } from 'vitest';

import { readPolicyOptionsFromAction } from '../src/index.js';

const repoRoot = resolve(__dirname, '..');

describe('action metadata', () => {
  test('publishes a Node 24 GitHub Action with policy inputs and machine-readable outputs', () => {
    const action = parse(readFileSync(resolve(repoRoot, 'action.yml'), 'utf8'));

    expect(action.runs).toEqual({
      using: 'node24',
      main: 'dist/index.cjs'
    });
    expect(Object.keys(action.inputs)).toEqual([
      'minimum-node-version',
      'preferred-node-version',
      'dependency-policy',
      'scan-dependencies',
      'allow-floating',
      'allow-missing',
      'fix-mode',
      'ignore-paths'
    ]);
    expect(Object.keys(action.outputs)).toEqual([
      'status',
      'checked-count',
      'violation-count',
      'fixed-count',
      'changed-files-json',
      'summary-json'
    ]);
    expect(action.inputs['dependency-policy'].default).toBe('floor');
  });

  test('defaults action dependency policy to floor when input is omitted', () => {
    const options = readPolicyOptionsFromAction({ getInput: () => '' }, repoRoot);

    expect(options.dependencyPolicy).toBe('floor');
  });
});
