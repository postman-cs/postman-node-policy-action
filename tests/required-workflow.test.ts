import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, test } from 'vitest';

const repoRoot = resolve(__dirname, '..');

describe('required workflow', () => {
  test('can be selected as an org ruleset required workflow', () => {
    const workflow = parse(readFileSync(resolve(repoRoot, '.github/workflows/enforce-node22.yml'), 'utf8'));

    expect(workflow.on).toEqual({
      pull_request: {},
      merge_group: {}
    });
    expect(workflow.permissions).toEqual({
      contents: 'read'
    });
    const steps = workflow.jobs['node-policy'].steps;
    expect(steps[0]).toEqual({ uses: 'actions/checkout@v6' });
    expect(steps[1]).toEqual({
      uses: 'actions/setup-node@v6',
      with: {
        'node-version': '24'
      }
    });
    expect(steps[2]).toMatchObject({
      name: 'Install Yarn dependency metadata',
      shell: 'bash'
    });
    expect(steps[2].run).toContain('find . -name yarn.lock');
    expect(steps[2].run).toContain('yarn install --immutable --mode=skip-build');
    expect(steps[2].run).toContain('yarn install --frozen-lockfile --ignore-scripts');
    expect(steps[3]).toEqual({
      uses: 'postman-cs/postman-node-policy-action@v1',
      with: {
        'minimum-node-version': '22',
        'preferred-node-version': '24',
        'dependency-policy': 'floor',
        'scan-dependencies': 'true'
      }
    });
  });
});
