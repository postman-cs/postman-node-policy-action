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
    expect(workflow.jobs['node-policy'].steps).toEqual([
      { uses: 'actions/checkout@v6' },
      {
        uses: 'postman-cs/postman-node-policy-action@v1',
        with: {
          'minimum-node-version': '22',
          'preferred-node-version': '24',
          'dependency-policy': 'compatible',
          'scan-dependencies': 'true'
        }
      }
    ]);
  });
});
